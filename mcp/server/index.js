#!/usr/bin/env node
/**
 * bridge MCP server — exposes the local agent-bridge hub to MCP hosts (OpenCode).
 *
 * Tools:
 *   bridge_list_agents     list connected agents
 *   bridge_publish         publish a message to the hub (kind + payload)
 *   bridge_rpc             call an RPC on another agent (e.g. task a Hermes run)
 *   bridge_ping            liveness check against the hub
 *
 * Env:
 *   BRIDGE_URL   (default ws://127.0.0.1:8177)
 *   BRIDGE_TOKEN (optional auth token)
 *   BRIDGE_ID    (default "opencode")
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import { z } from 'zod';

const URL = process.env.BRIDGE_URL || 'ws://127.0.0.1:8177';
const TOKEN = process.env.BRIDGE_TOKEN || '';
const ID = process.env.BRIDGE_ID || 'opencode';

/** Tiny promise-based WS client for the bridge wire protocol. */
class Bridge {
  constructor(url, id, token) {
    this.url = url; this.id = id; this.token = token;
    this.ws = null; this.seq = 0; this.waiters = new Map();
    this.listeners = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({ v: 1, type: 'hello', id: this.id, agent: 'opencode', token: this.token, capabilities: ['all-topics'], topics: [] }));
      });
      ws.on('message', (d) => this._route(JSON.parse(d.toString())));
      ws.on('error', reject);
      // wait for hello_ack
      this.waiters.set('#ack', { resolve, reject });
    });
  }
  _route(msg) {
    if (msg.type === 'hello_ack') { const w = this.waiters.get('#ack'); if (w) { this.waiters.delete('#ack'); w.resolve(msg); } return; }
    if (msg.type === 'agents') { const w = this.waiters.get('#list'); if (w) { this.waiters.delete('#list'); w.resolve(msg); } return; }
    if (msg.type === 'rpc_result') { const w = this.waiters.get(msg.request_id); if (w) { this.waiters.delete(msg.request_id); msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error || 'rpc failed')); } return; }
    const l = this.listeners.get(msg.type);
    if (l) for (const fn of l) fn(msg);
  }
  _send(o) { this.ws.send(JSON.stringify(o)); }
  async listAgents() {
    return new Promise((resolve, reject) => {
      this.waiters.set('#list', { resolve, reject });
      setTimeout(() => { if (this.waiters.get('#list')) { this.waiters.delete('#list'); reject(new Error('list timeout')); } }, 4000);
      this._send({ v: 1, type: 'list' });
    });
  }
  async publish(kind, payload, to = '*') {
    this._send({ v: 1, type: 'publish', envelope: { kind, payload, to } });
    return { ok: true, kind, from: this.id, to };
  }
  async rpc(to, method, params = {}, timeout = 60000) {
    const request_id = `${this.id}:${++this.seq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.waiters.get(request_id)) { this.waiters.delete(request_id); reject(new Error('rpc timeout (' + method + ')')); } }, timeout);
      this.waiters.set(request_id, { resolve, reject });
      this._send({ v: 1, type: 'rpc', to, method, params, request_id });
    });
  }
  on(type, fn) { (this.listeners.get(type) || this.listeners.set(type, []).get(type)).push(fn); }
}

const server = new McpServer({ name: 'agent-bridge', version: '1.0.0' });

server.tool('bridge_list_agents', 'List agents currently connected to the local bridge hub.', {}, async () => {
  const b = new Bridge(URL, ID, TOKEN);
  await b.connect();
  try {
    const res = await b.listAgents();
    return { content: [{ type: 'text', text: JSON.stringify(res.agents, null, 2) }] };
  } finally { try { b.ws.close(); } catch (e) {} }
});

server.tool('bridge_publish', 'Publish a message to the local bridge hub (e.g. a note or a task addressed to another agent).', {
  kind: z.string().describe('Topic: task, note, state, file, or any free-form string'),
  payload: z.any().describe('Arbitrary JSON payload'),
  to: z.string().optional().describe('Target agent id, or "*" to broadcast (default)')
}, async ({ kind, payload, to }) => {
  const b = new Bridge(URL, ID, TOKEN);
  await b.connect();
  try {
    const res = await b.publish(kind, payload, to || '*');
    return { content: [{ type: 'text', text: JSON.stringify(res) }] };
  } finally { try { b.ws.close(); } catch (e) {} }
});

server.tool('bridge_rpc', 'Call a method on another agent through the bridge (e.g. run a one-shot task on Hermes).', {
  to: z.string().describe('Target agent id (e.g. "hermes", "opencode", "filebridge")'),
  method: z.string().describe('Method name (Hermes: run, status, send, ping)'),
  params: z.any().optional().describe('Method arguments as JSON'),
  timeout: z.number().optional().describe('Timeout ms (default 60000)')
}, async ({ to, method, params, timeout }) => {
  const b = new Bridge(URL, ID, TOKEN);
  await b.connect();
  try {
    const res = await b.rpc(to, method, params || {}, timeout || 60000);
    return { content: [{ type: 'text', text: (typeof res === 'string') ? res : JSON.stringify(res) }] };
  } finally { try { b.ws.close(); } catch (e) {} }
});

server.tool('bridge_ping', 'Check that the local bridge hub is up.', {}, async () => {
  const b = new Bridge(URL, ID, TOKEN);
  await b.connect();
  return { content: [{ type: 'text', text: 'pong' }] };
});

const t = new StdioServerTransport();
await server.connect(t);
