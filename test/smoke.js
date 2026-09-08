'use strict';
/** End-to-end smoke test of the bridge hub. */
const { BridgeClient } = require('../lib/client');

async function main() {
  // subscriber A
  const sub = new BridgeClient({ id: 'test-sub', agent: 'opencode', topics: ['task'] });
  await sub.connect();
  const received = [];
  sub.on('message', (env) => received.push(env));

  // publisher B
  const pub = new BridgeClient({ id: 'test-pub', agent: 'opencode' });
  await pub.connect();

  const agents = await pub.listAgents();
  console.log('agents:', agents.map(a => a.id).join(','));

  await sub.subscribe(['task']);
  await pub.publish('task', { body: 'hello from pub' }, { to: '*' });

  // wait for delivery
  await new Promise((r) => setTimeout(r, 800));

  console.log('received count:', received.length);
  if (received.length >= 1) {
    const first = received[0];
    console.log('received kind:', first.kind, 'from:', first.from, 'payload body:', first.payload && first.payload.body);
    if (first.kind === 'task' && first.from === 'test-pub' && first.payload.body === 'hello from pub') {
      console.log('RESULT: PASS');
    } else {
      console.log('RESULT: FAIL (payload mismatch)');
      sub.close(); pub.close(); process.exit(1);
    }
  } else {
    console.log('RESULT: FAIL (no delivery)');
    sub.close(); pub.close(); process.exit(1);
  }
  // rpc test: pub -> sub (sub responds)
  sub.on('rpc', async (m) => {
    if (m.method === 'echo') sub.respond(m.request_id, { echo: m.params });
  });
  const rpcRes = await pub.rpc('test-sub', 'echo', { hi: 1 });
  console.log('rpc result:', JSON.stringify(rpcRes));
  console.log(rpcRes && rpcRes.echo && rpcRes.echo.hi === 1 ? 'RPC RESULT: PASS' : 'RPC RESULT: FAIL');

  sub.close(); pub.close();
  process.exit(0);
}

main().catch((e) => { console.error('test error:', e); process.exit(1); });
