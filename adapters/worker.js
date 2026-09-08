'use strict';
/**
 * worker adapter — a generic, independent bridge peer.
 *
 * Proves the mesh handles N agents and gives you a ready-made template for
 * adding any agent (a second OpenCode, OpenHand, a CI runner, ...).
 *
 * Behaviors:
 *   - joins the hub as `worker-1`
 *   - `task` messages -> ack result published back as `task_result` from worker-1
 *   - rpc `ping` / `status`
 *
 * Run more copies with BRIDGE_ID=worker-2, worker-3, ...
 */
const { BridgeClient } = require('../lib/client');

const BRIDGE_ID = process.env.BRIDGE_ID || 'worker-1';
const AGENT = process.env.BRIDGE_AGENT || BRIDGE_ID;

async function main() {
  const client = new BridgeClient({ id: BRIDGE_ID, agent: AGENT, topics: ['task', 'note', 'state', '*'] });
  await client.connect();
  console.log(`[${AGENT}] connected to hub as "${BRIDGE_ID}"`);

  client.on('message', async (env) => {
    if (env.kind === 'task') {
      console.log(`[${AGENT}] task from ${env.from}: ${JSON.stringify(env.payload).slice(0, 120)}`);
      client.publish('task_result', {
        ok: true, worker: BRIDGE_ID, note: 'ack from generic worker',
        echo: env.payload,
      }, { to: env.from, envelopeExtra: { from: BRIDGE_ID } });
    }
  });

  client.on('rpc', async (msg) => {
    try {
      if (msg.method === 'ping') client.respond(msg.request_id, { ok: true, agent: BRIDGE_ID, ts: new Date().toISOString() });
      else if (msg.method === 'status') client.respond(msg.request_id, { worker: BRIDGE_ID, alive: true });
      else client.respond(msg.request_id, { ok: false, error: 'unknown method: ' + msg.method });
    } catch (e) {
      client.respond(msg.request_id, { ok: false, error: e.message });
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((e) => { console.error(`[${BRIDGE_ID}] fatal`, e); process.exit(1); });