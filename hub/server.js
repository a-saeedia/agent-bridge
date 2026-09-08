'use strict';
/**
 * bridge hub — local WebSocket broker for connecting AI agents.
 * Binds to 127.0.0.1 only. Fan-out of JSON envelopes + optional token auth.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = parseInt(process.env.BRIDGE_PORT || '8177', 10);
const TOKEN = process.env.BRIDGE_TOKEN || ''; // empty = auth disabled

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.BRIDGE_DATA || path.join(ROOT, 'bridge-data');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const STATE_DIR = path.join(DATA_DIR, 'state');
const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
const INBOX_DIR = path.join(DATA_DIR, 'inbox');

for (const d of [EVENTS_DIR, STATE_DIR, OUTBOX_DIR, INBOX_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/** @type {Map<string,{agent:string,id:string,socket:any,topics:Set<string>,seq:number,caps:Set<string>}>} */
const agents = new Map();

function eventFile(seq) {
  return path.join(EVENTS_DIR, `${String(seq).padStart(6, '0')}.json`);
}
function nextEventSeq() {
  const files = fs.readdirSync(EVENTS_DIR).map((f) => parseInt(f, 10)).filter(Number.isFinite);
  const max = files.length ? Math.max(...files) : 0;
  return max + 1;
}

function mirrorState(payload) {
  if (!payload || typeof payload !== 'object') return;
  const key = String(payload.key || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(STATE_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...payload, _mirroredAt: new Date().toISOString() }, null, 2));
}

function deliver(client, msg) {
  if (client.socket.readyState === 1) {
    try { client.socket.send(JSON.stringify(msg)); } catch (e) { /* drop */ }
  }
}

function broadcast(envelope, excludeId) {
  const json = JSON.stringify({ v: 1, type: 'deliver', envelope });
  const target = envelope.to || '*';
  for (const [id, client] of agents) {
    if (id === excludeId) continue;
    if (client.socket.readyState !== 1) continue;
    // directed delivery: only the addressed agent gets it (mirror clients —
    // the outbox shelf — still record everything)
    if (target !== '*' && target !== id && !client.caps.has('mirror')) continue;
    // topic filter
    if (client.topics.size && !client.topics.has(envelope.kind) && !client.topics.has('*')) continue;
    try { client.socket.send(json); } catch (e) { /* drop */ }
  }
  // outbox mirror for no-API agents
  fs.appendFileSync(
    path.join(EVENTS_DIR, 'events.ndjson'),
    JSON.stringify(envelope) + '\n',
    'utf8'
  );
}

function handle(payload, client, reply) {
  if (!payload || typeof payload !== 'object') return;
  const type = payload.type;
  switch (type) {
    case 'hello': {
      const id = String(payload.id || payload.agent || 'anon').slice(0, 80);
      if (TOKEN && payload.token !== TOKEN) {
        client.socket.send(JSON.stringify({ v: 1, type: 'error', error: 'unauthorized' }));
        client.socket.close();
        return;
      }
      const existing = agents.get(id);
      if (existing && existing.socket !== client.socket) { try { existing.socket.close(); } catch (e) {} }
      const caps = new Set(payload.capabilities || []);
      const topics = new Set((payload.topics || []).concat(caps.has('all-topics') ? ['*'] : []));
      agents.set(id, {
        agent: String(payload.agent || id), id, socket: client.socket,
        topics, caps, seq: 0,
      });
      client.id = id;
      client.agent = String(payload.agent || id);
      client.caps = caps;
      client.topics = topics;
      reply({ type: 'hello_ack', agent_id: id, welcome: true, ts: new Date().toISOString() });
      return;
    }
    case 'subscribe': {
      for (const t of payload.topics || []) client.topics.add(String(t));
      reply({ type: 'subscribed', topics: [...client.topics] });
      return;
    }
    case 'publish': {
      // filebridge (and any proxy-capable client) may set `from` to attribute the
      // message to the real origin (e.g. a program that dropped a file on disk).
      const useFrom = client.caps.has('proxy-from') && payload.envelope && payload.envelope.from
        ? payload.envelope.from
        : client.id;
      const env = Object.assign({}, payload.envelope, { from: useFrom });
      env.seq = ++client.seq;
      env.ts = env.ts || new Date().toISOString();
      env.kind = env.kind || 'event';
      broadcast(env, null);
      if (env.kind === 'state' || (env.payload && env.payload.key)) mirrorState(env.payload);
      reply({ type: 'published', seq: env.seq });
      return;
    }
    case 'rpc': {
      const to = payload.to;
      const target = agents.get(to);
      if (!target) { reply({ type: 'rpc_result', request_id: payload.request_id, ok: false, error: 'no such agent: ' + to }); return; }
      deliver(target, {
        v: 1, type: 'rpc', from: client.id, to, seq: ++client.seq,
        method: payload.method, params: payload.params, request_id: payload.request_id,
      });
      // rpc_result returned by the target client via the normal 'rpc_result' message
      return;
    }
    case 'rpc_result': {
      // route back to original requester (hub doesn't track routing in v1; requester filters by request_id)
      const requester = agents.get(payload.to);
      if (requester) deliver(requester, { v: 1, type: 'rpc_result', ...payload, from: client.id });
      return;
    }
    case 'list': {
      reply({ type: 'agents', agents: [...agents.values()].map(a => ({ id: a.id, agent: a.agent, capabilities: [...a.caps], topics: [...a.topics] })) });
      return;
    }
    case 'ping': {
      reply({ type: 'pong', ts: new Date().toISOString() });
      return;
    }
    case 'file_sync': {
      // payload: { event: 'created'|'changed'|'deleted', path, ... }
      const env = { v: 1, type: 'deliver', envelope: { from: 'filestore', kind: 'file', payload, ts: new Date().toISOString() } };
      broadcast(env, null);
      reply({ type: 'ok' });
      return;
    }
    default:
      reply({ type: 'error', error: 'unknown type: ' + type });
  }
}

function wire(socket) {
  let client = { socket, id: 'anon', agent: 'anon', topics: new Set(), caps: new Set(), seq: 0 };
  const reply = (msg) => { if (socket.readyState === 1) socket.send(JSON.stringify({ v: 1, ...msg })); };
  socket.on('message', (data) => {
    let payload;
    try { payload = JSON.parse(data.toString()); } catch (e) {
      reply({ type: 'error', error: 'bad json' }); return;
    }
    handle(payload, client, reply);
  });
  socket.on('close', () => {
    if (client.id && agents.get(client.id)?.socket === socket) agents.delete(client.id);
  });
  socket.on('error', () => { try { socket.close(); } catch (e) {} });
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('agent-bridge hub on 127.0.0.1:' + PORT + '\n');
});

const wss = new WebSocketServer({ server, host: HOST });
wss.on('connection', wire);

server.listen(PORT, HOST, () => {
  console.log(`[bridge] hub listening on ${HOST}:${PORT}`);
  console.log(`[bridge] data dir: ${DATA_DIR}`);
  console.log(`[bridge] wired: OpenCode / Hermes / file bridge. waiting for agents...`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
