'use strict';
/** Isolate: does the hub honor proxy-from? */
const { BridgeClient } = require('../lib/client');

async function main() {
  // listener
  const sub = new BridgeClient({ id: 'listener', agent: 'test' });
  await sub.connect();
  const received = [];
  sub.on('message', (env) => { received.push(env); console.log('LISTENER got:', JSON.stringify({ from: env.from, kind: env.kind, body: env.payload && env.payload.body })); });

  await sub.subscribe(['*']);

  // proxy publisher advertising proxy-from
  const proxy = new BridgeClient({ id: 'proxy', agent: 'test', capabilities: ['proxy-from'] });
  await proxy.connect();

  await new Promise(r => setTimeout(r, 500));
  await proxy.publish('task', { body: 'proxy test' }, { to: '*', envelopeExtra: { from: 'freebuff' } });

  await new Promise(r => setTimeout(r, 800));
  console.log('received count:', received.length);
  proxy.close(); sub.close();
  if (received.length && received[0].from === 'freebuff') console.log('PROXY-FROM: PASS');
  else console.log('PROXY-FROM: FAIL (got from=' + (received[0] && received[0].from) + ')');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
