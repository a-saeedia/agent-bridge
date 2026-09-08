'use strict';
/** Smoke-test the bridge MCP server over stdio. */
const { spawn } = require('child_process');

const mcp = spawn(process.execPath, ['server/index.js'], {
  cwd: 'C:\\Users\\user\\Desktop\\the merge\\mcp',
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const results = [];
mcp.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { results.push(JSON.parse(line)); } catch (e) {}
  }
});

const send = (o) => mcp.stdin.write(JSON.stringify(o) + '\n');

async function waitFor(pred, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = results.find(pred);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('timeout waiting for response; got ' + JSON.stringify(results));
}

(async () => {
  // 1. initialize
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
  await waitFor(r => r.id === 1);
  console.log('initialize OK');

  // 2. initialized notification
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 3. list tools
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await waitFor(r => r.id === 2);
  const names = tools.result.tools.map(t => t.name);
  console.log('tools:', names.join(', '));

  // 4. bridge_ping
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_ping', arguments: {} } });
  const ping = await waitFor(r => r.id === 3);
  const text = ping.result && ping.result.content && ping.result.content[0] && ping.result.content[0].text;
  console.log('bridge_ping ->', text);
  console.log(text === 'pong' ? 'MCP SMOKE: PASS' : 'MCP SMOKE: FAIL');

  mcp.kill();
  process.exit(0);
})().catch(e => { console.error('MCP SMOKE FAIL', e.message); mcp.kill(); process.exit(1); });