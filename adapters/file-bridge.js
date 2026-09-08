'use strict';
/**
 * file-drop bridge — bridges the WebSocket hub to plain files on disk.
 *
 * - INBOX: any file dropped into bridge-data/inbox/ is published to the hub
 *   as a `task` from agent `<filebasename>` (drop `hermes.task` -> from "hermes"),
 *   or from the agent id in a `{ "from": ... }` JSON body if ".json".
 * - OUTBOX: hub deliveries addressed to agents not currently connected (or whose
 *   client is the file bridge) are written to bridge-data/outbox/<seq>-<from>-<kind>.json
 *   so a no-API program can pick them up.
 */
const fs = require('fs');
const path = require('path');
const { BridgeClient } = require('../lib/client');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.BRIDGE_DATA || path.join(ROOT, 'bridge-data');
const INBOX = process.env.BRIDGE_INBOX || path.join(DATA_DIR, 'inbox');
const OUTBOX = process.env.BRIDGE_OUTBOX || path.join(DATA_DIR, 'outbox');

const ID = process.env.BRIDGE_FILE_ID || 'filebridge';
const AGENT = 'filebridge';

const seen = new Set();
// Any file that has already been consumed is renamed to `<name>.consumed` and
// must never be re-ingested (avoids infinitely re-reading the watch event).
function isConsumed(file) {
  return /\.consumed(\.|\d|$)/i.test(file) || /\.consumed$/i.test(file) || file.includes('.consumed');
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function readInbox(file) {
  const full = path.join(INBOX, file);
  let body;
  try { body = fs.readFileSync(full, 'utf8'); } catch (e) { return null; }
  body = stripBom(body);
  let payload = { body };
  let from = ID;
  let kind = 'task';
  let to = '*';
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      payload = parsed.payload || parsed;
      if (parsed.from) from = parsed.from;
      if (parsed.kind) kind = parsed.kind;
      if (parsed.to) to = parsed.to;
    }
  } catch (e) {
    // not JSON -> treat raw body as payload
    from = path.basename(file, path.extname(file)).toLowerCase() || from;
  }
  return { from, kind, to, payload };
}

function ingest(client) {
  let files;
  try { files = fs.readdirSync(INBOX); } catch (e) { return; }
  for (const file of files) {
    if (file.startsWith('.') || isConsumed(file) || /\.(tmp|part)$/i.test(file)) continue;
    const full = path.join(INBOX, file);
    // track by original name so a rename to .consumed doesn't re-process
    if (seen.has(file)) continue;
    seen.add(file);
    const msg = readInbox(file);
    console.log(`[filebridge] inbox: ${file} -> publish task from "${msg.from}"`);
    client.publish(msg.kind, msg.payload, { to: msg.to, envelopeExtra: { from: msg.from } });
    try { fs.renameSync(full, full + '.consumed' + '.done'); } catch (e) { try { fs.unlinkSync(full); } catch (e2) {} }
  }
}

function fileChange(client) {
  return (eventType, filename) => {
    if (!filename) { ingest(client); return; }
    // debounce
    setTimeout(() => ingest(client), 300);
  };
}

async function main() {
  const client = new BridgeClient({ id: ID, agent: AGENT, topics: ['*'], capabilities: ['proxy-from', 'mirror'] });
  await client.connect();
  console.log(`[filebridge] connected as "${ID}".`);
  console.log(`[filebridge] watching inbox: ${INBOX}`);
  console.log(`[filebridge] writing outbox:  ${OUTBOX}`);

  // watch inbox
  try { fs.watch(INBOX, { persistent: true }, fileChange(client)); } catch (e) { console.error('[filebridge] watch failed', e); }
  ingest(client);

  // write deliveries to outbox
  client.on('message', (env) => {
    const target = env.to;
    // only materialize messages explicitly addressed to a file agent, or broadcast state/task
    if (target && target !== '*' && target !== ID) return;
    const safeFrom = String(env.from || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
    const safeKind = String(env.kind || 'event').replace(/[^A-Za-z0-9._-]/g, '_');
    const fname = `${String(env.seq || Date.now()).padStart(6, '0')}-${safeFrom}-${safeKind}.json`;
    const out = path.join(OUTBOX, fname);
    fs.writeFileSync(out, JSON.stringify({ v: 1, envelope: env, _deliveredAt: new Date().toISOString() }, null, 2));
    console.log(`[filebridge] outbox: ${fname}`);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((e) => { console.error('[filebridge] fatal', e); process.exit(1); });
