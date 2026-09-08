#!/usr/bin/env node
'use strict';
/**
 * bridge — CLI for the agent bridge hub.
 *
 *   bridge list                        list connected agents
 *   bridge publish <kind> <json|text>  publish an envelope (default from "opencode")
 *   bridge listen [topics...]          subscribe and print messages (JSON lines)
 *   bridge rpc <to> <method> [json]    call an rpc on another agent
 *   bridge ping'                       liveness check
 *
 * Env: BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_ID, BRIDGE_AGENT
 */
const { BridgeClient } = require('../lib/client');

const [,, cmd, ...rest] = process.argv;
const id = process.env.BRIDGE_ID || process.env.OPCODE_AGENT_ID || 'opencode';
const agent = process.env.BRIDGE_AGENT || 'opencode';

function parsePayload(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return { body: raw }; }
}

function usage() {
  console.log(`bridge CLI
  list                                   list connected agents
  publish <kind> [json]                  publish a message (from "${id}")
  listen [topic...]                      subscribe and print JSON-lines
  rpc <to> <method> [json]               rpc call
  ping                                   liveness`);
}

async function main() {
  const client = new BridgeClient({ id, agent, topics: [] });
  await client.connect();

  switch (cmd) {
    case 'list': {
      const a = await client.listAgents();
      console.log(JSON.stringify(a, null, 2));
      break;
    }
    case 'publish': {
      const kind = rest[0] || 'note';
      const payload = parsePayload(rest.slice(1).join(' '));
      await client.publish(kind, payload);
      console.log(`published ${kind}`);
      break;
    }
    case 'listen': {
      const topics = rest.length ? rest : ['*'];
      await client.subscribe(topics);
      console.error(`[bridge] listening on: ${topics.join(', ')} (ctrl-c to stop)`);
      client.on('message', (env) => console.log(JSON.stringify(env)));
      // keep alive
      setInterval(() => { try { client.ws.ping(); } catch (e) {} }, 15000);
      break;
    }
    case 'rpc': {
      const to = rest[0];
      const method = rest[1];
      const params = rest.length > 2 ? parsePayload(rest.slice(2).join(' ')) : {};
      const result = await client.rpc(to, method, params);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'ping': {
      const out = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('hub unreachable at ' + client.url)), 2000);
        client.once('pong', (m) => { clearTimeout(t); res(m); });
        client.ws.send(JSON.stringify({ v: 1, type: 'ping' }));
      });
      console.log('pong', JSON.stringify(out));
      break;
    }
    default:
      usage();
      process.exitCode = 1;
  }
  await client.close();
}

main().catch((e) => { console.error('bridge error:', e.message); process.exit(1); });
