#!/usr/bin/env node
/**
 * hermes-gateway adapter — connects the bridge hub to Hermes's messaging gateway.
 *
 * Hermes exposes its messaging gateway (Telegram/Discord/WhatsApp/Slack/Signal/email)
 * as an MCP server: `hermes mcp serve`. This adapter is the MCP *client* for that
 * server, so every agent on the hub can reach any messaging platform through Hermes.
 *
 * Hub agent id:        hermes-gw
 * RPC methods:
 *   status          gateway + connected agents summary
 *   channels        list sendable targets (platform:chat_id)
 *   conversations   list active conversations
 *   send            { target, message } -> messages_send
 *   read            { session_key, limit } -> messages_read
 *   poll            { after_cursor, session_key, limit } -> events_poll
 *   ping            liveness
 *
 * Inbound hub tasks of kind `message` with payload {target, message} are sent
 * through the gateway (the file-drop / any-agent path to Telegram etc).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import mod from '../lib/client.js';
const { BridgeClient } = mod;

const HERMES_BIN = process.env.HERMES_BIN ||
  'C:\\Users\\user\\AppData\\Local\\hermes\\bin\\hermes.exe';
const AGENT = 'hermes-gw';
const BRIDGE_ID = process.env.BRIDGE_ID || AGENT;

let hc = null; // hermes MCP client

async function connectHermes() {
  const transport = new StdioClientTransport({
    command: HERMES_BIN,
    args: ['mcp', 'serve', '--accept-hooks'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agent-bridge', version: '1.0.0' });
  await client.connect(transport);
  hc = client;
  const tools = await client.listTools();
  return tools.tools.map((t) => t.name);
}

async function call(name, args = {}) {
  const r = await hc.callTool({ name, arguments: args });
  // MCP result: { content: [ {type:'text', text} ] }
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  let parsed = text;
  try { parsed = JSON.parse(text); } catch (e) { /* keep raw text */ }
  return parsed;
}

async function main() {
  const client = new BridgeClient({ id: BRIDGE_ID, agent: AGENT, topics: ['task', 'note', 'state', 'message', '*'] });
  await client.connect();
  console.log(`[${AGENT}] connected to hub as "${BRIDGE_ID}"`);

  const toolNames = await connectHermes();
  console.log(`[${AGENT}] hermes mcp serve connected; tools: ${toolNames.join(', ')}`);

  // inbound: a `task` or `message` addressed to the gateway -> send via Hermes
  client.on('message', async (env) => {
    if (env.kind === 'message' || (env.kind === 'task' && env.payload && (env.payload.target || env.payload.to))) {
      const target = env.payload.target || env.payload.to;
      const message = env.payload.message || env.payload.body || env.payload.prompt || '';
      if (!target || !message) return;
      try {
        const res = await call('messages_send', { target, message });
        client.publish('task_result', { ok: true, target, sent: true, result: res }, { to: env.from, envelopeExtra: { from: AGENT } });
        console.log(`[${AGENT}] sent via hermes gateway to ${target}`);
      } catch (e) {
        client.publish('task_result', { ok: false, target, error: e.message }, { to: env.from, envelopeExtra: { from: AGENT } });
      }
    }
  });

  // rpc surface
  client.on('rpc', async (msg) => {
    try {
      const m = msg.method;
      let result;
      if (m === 'ping') result = { ok: true, agent: AGENT, ts: new Date().toISOString() };
      else if (m === 'channels') result = { channels: await call('channels_list', { platform: msg.params && msg.params.platform }) };
      else if (m === 'conversations') result = { conversations: await call('conversations_list', { limit: (msg.params && msg.params.limit) || 20 }) };
      else if (m === 'send') {
        const p = msg.params || {};
        result = { sent: await call('messages_send', { target: p.target, message: p.message }) };
      } else if (m === 'read') {
        const p = msg.params || {};
        result = { messages: await call('messages_read', { session_key: p.session_key, limit: (p.limit) || 50 }) };
      } else if (m === 'poll') {
        const p = msg.params || {};
        result = { events: await call('events_poll', { after_cursor: p.after_cursor, session_key: p.session_key, limit: p.limit }) };
      } else if (m === 'status') {
        const chan = await call('channels_list', {}).catch(() => []);
        const conv = await call('conversations_list', { limit: 5 }).catch(() => []);
        result = { agent: AGENT, tools: toolNames, channels: chan, recent_conversations: conv };
      } else {
        result = { ok: false, error: 'unknown method: ' + m };
      }
      client.respond(msg.request_id, result);
    } catch (e) {
      client.respond(msg.request_id, { ok: false, error: e.message });
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((e) => { console.error(`[${AGENT}] fatal`, e); process.exit(1); });