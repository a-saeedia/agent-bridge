'use strict';
/**
 * bridge client library — programmatic API + shared logic.
 * Connects to the local hub over WebSocket.
 */
const WebSocket = require('ws');
const { EventEmitter } = require('events');

const DEFAULT_URL = process.env.BRIDGE_URL || 'ws://127.0.0.1:8177';

class BridgeClient extends EventEmitter {
  /** @param {string} id @param {string} agent */
  constructor({ url = DEFAULT_URL, id, agent = id, token = process.env.BRIDGE_TOKEN || '', topics = [], capabilities = [] } = {}) {
    super();
    this.url = url;
    this.id = id;
    this.agent = agent;
    this.token = token;
    this.topics = new Set(topics);
    this.capabilities = capabilities;
    this.ws = null;
    this.seq = 0;
    this.pendingRpc = new Map();
    this._connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          v: 1, type: 'hello', id: this.id, agent: this.agent,
          token: this.token, topics: [...this.topics], capabilities: ['all-topics', ...this.capabilities],
        }));
        this._connected = true;
        this.emit('connected');
        resolve(this);
      });
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        this._onMessage(msg);
      });
      ws.on('close', () => { this._connected = false; this.emit('disconnected'); });
      ws.on('error', (err) => { this.emit('error', err); reject(err); });
    });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'hello_ack':
        this.emit('ready', msg);
        break;
      case 'deliver':
        // envelope may be nested under msg.envelope or inline
        const env = msg.envelope || msg;
        this.emit('message', env);
        break;
      case 'rpc':
        this._lastRpcFrom = msg.from;
        this._lastRpcId = msg.request_id;
        this.emit('rpc', msg);
        break;
      case 'rpc_result':
        const p = this.pendingRpc.get(msg.request_id);
        if (p) { this.pendingRpc.delete(msg.request_id); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'rpc failed')); }
        break;
      case 'agents':
        this.emit('agents', msg.agents);
        break;
      default:
        this.emit(msg.type, msg);
    }
  }

  publish(kind, payload, { to = '*', envelopeExtra = {} } = {}) {
    return this._send('publish', { envelope: { kind, payload, to, ...envelopeExtra } });
  }

  subscribe(topics) {
    this.topics = new Set([...this.topics, ...topics]);
    return this._send('subscribe', { topics });
  }

  listAgents() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('list timeout')), 3000);
      this.once('agents', (a) => { clearTimeout(t); resolve(a); });
      this._send('list', {});
    });
  }

  rpc(to, method, params = {}, timeout = 15000) {
    const request_id = `${this.id}:${++this.seq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pendingRpc.delete(request_id); reject(new Error('rpc timeout')); }, timeout);
      this.pendingRpc.set(request_id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this._send('rpc', { to: to === '*' ? undefined : to, method, params, request_id });
    });
  }

  respond(request_id, result) {
    return this._send('rpc_result', { request_id, ok: true, result, to: this._lastRpcFrom });
  }

  _send(type, body) {
    this.ws.send(JSON.stringify({ v: 1, type, ...body }));
  }

  close() { try { this.ws.close(); } catch (e) {} }
}

module.exports = { BridgeClient, DEFAULT_URL };
