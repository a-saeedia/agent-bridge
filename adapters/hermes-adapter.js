'use strict';
/**
 * Hermes adapter — connects the hub to Hermes Agent.
 *
 * Inbound (from our bridge hub) -> Hermes:
 *   - `task`  messages run `hermes -z "<prompt>"` headless (one-shot, no TTY)
 *     and publish the result back to the hub as a `task_result` from `hermes`.
 *   - `rpc` method `run`      -> same as task (alias)
 *   - `rpc` method `status`   -> `hermes status`
 *   - `rpc` method `send`     -> `hermes send --to <target> <msg>` (messaging
 *      backplane; requires a configured platform via `hermes gateway setup`)
 *   - `rpc` method `sessions` -> `hermes sessions list`
 *   - `rpc` method `cron`     -> `hermes cron list` (cron_list/pause/resume/run
 *      act on a specific job id)
 *   - `rpc` method `memory`   -> `hermes memory status`
 *   - `rpc` method `gateway`  -> `hermes gateway status`
 *   - `rpc` method `cron_pause|cron_resume|crone_run` -> operate a job
 *
 * Outbound Hermes -> bridge hub: the adapter itself is the Hermes connection,
 * so anything Hermes knows about can be published when the CLI exposes it.
 *
 * Set HERMES_BIN to override the hermes.exe path.
 */
const { execFile } = require('child_process');
const { BridgeClient } = require('../lib/client');

const HERMES_BIN = process.env.HERMES_BIN ||
  'C:\\Users\\user\\AppData\\Local\\hermes\\bin\\hermes.exe';
const BRIDGE_ID = process.env.BRIDGE_ID || 'hermes';
const AGENT = 'hermes';

function runHermes(args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(HERMES_BIN, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function oneShot(task) {
  const prompt = typeof task === 'string' ? task
    : (task && (task.prompt || task.message || task.body || '' ));
  if (!prompt) return { ok: false, error: 'no prompt/message/body in task' };
  const out = await runHermes(['-z', prompt]);
  return { ok: true, output: out };
}

async function main() {
  const client = new BridgeClient({ id: BRIDGE_ID, agent: AGENT, topics: ['task', 'note', 'state', '*'] });
  await client.connect();
  console.log(`[hermes] connected as "${BRIDGE_ID}", hermes bin: ${HERMES_BIN}`);

  // inbound tasks
  client.on('message', async (env) => {
    if (env.kind === 'task') {
      console.log(`[hermes] task from ${env.from}: ${JSON.stringify(env.payload).slice(0, 200)}`);
      try {
        const result = await oneShot(env.payload);
        client.publish('task_result', result, { to: env.from, envelopeExtra: { from: AGENT } });
      } catch (e) {
        console.error(`[hermes] task failed: ${e.message}`);
        client.publish('task_result', { ok: false, error: e.message }, { to: env.from, envelopeExtra: { from: AGENT } });
      }
    }
  });

  // rpc
  client.on('rpc', async (msg) => {
    try {
      if (msg.method === 'run') {
        const result = await oneShot(msg.params);
        client.respond(msg.request_id, result);
      } else if (msg.method === 'status') {
        const out = await runHermes(['status'], { timeout: 20000 }).catch(() => 'hermes status unavailable');
        client.respond(msg.request_id, { status: out });
      } else if (msg.method === 'send') {
        const t = msg.params.target || msg.params.to;
        const text = msg.params.message || msg.params.text || '';
        const args = ['send', '--to', t];
        if (msg.params.subject) args.push('--subject', msg.params.subject);
        args.push(text);
        const out = await runHermes(args, { timeout: 20000 });
        client.respond(msg.request_id, { ok: true, sent: true, result: out });
      } else if (msg.method === 'sessions') {
        const out = await runHermes(['sessions', 'list'], { timeout: 20000 }).catch(() => 'unavailable');
        client.respond(msg.request_id, { sessions: out });
      } else if (msg.method === 'cron') {
        const out = await runHermes(['cron', 'list'], { timeout: 20000 }).catch(() => 'unavailable');
        client.respond(msg.request_id, { cron: out });
      } else if (msg.method === 'cron_status') {
        const out = await runHermes(['cron', 'status'], { timeout: 20000 }).catch(() => 'unavailable');
        client.respond(msg.request_id, { cron_status: out });
      } else if (msg.method === 'cron_pause' || msg.method === 'cron_resume' || msg.method === 'cron_run') {
        const verb = msg.method.replace('cron_', '');
        const id = (msg.params || {}).id || (msg.params || {}).job;
        const args = ['cron', verb, id].filter(Boolean);
        const out = await runHermes(args, { timeout: 20000 }).catch(() => 'unavailable');
        client.respond(msg.request_id, { ok: true, result: out });
      } else if (msg.method === 'memory') {
        const out = await runHermes(['memory', 'status'], { timeout: 20000 }).catch(() => 'unavailable');
        client.respond(msg.request_id, { memory: out });
      } else if (msg.method === 'gateway') {
        const out = await runHermes(['gateway', 'status'], { timeout: 20000 }).catch(() => 'unavailable');
        client.respond(msg.request_id, { gateway: out });
      } else if (msg.method === 'ping') {
        client.respond(msg.request_id, { ok: true, agent: AGENT, ts: new Date().toISOString() });
      } else {
        client.respond(msg.request_id, { ok: false, error: 'unknown method: ' + msg.method });
      }
    } catch (e) {
      client.respond(msg.request_id, { ok: false, error: e.message });
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((e) => { console.error('[hermes] fatal', e); process.exit(1); });
