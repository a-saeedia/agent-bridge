// Discover what tools Hermes exposes when run as an MCP server (`hermes mcp serve`).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const hermesBin = 'C:\\Users\\user\\AppData\\Local\\hermes\\bin\\hermes.exe';

// Basic MCP stdio handshake
const transport = new StdioClientTransport({
  command: hermesBin,
  args: ['mcp', 'serve', '--accept-hooks'],
  cwd: 'C:\\Users\\user\\AppData\\Local\\hermes\\hermes-agent',
});

const client = new Client({ name: 'bridge-probe', version: '1.0.0' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('TOOL COUNT:', tools.tools.length);
  for (const t of tools.tools) {
    console.log('---');
    console.log('name:', t.name);
    console.log('desc:', (t.description || '').slice(0, 200));
    const schema = t.inputSchema || {};
    const props = Object.keys(schema.properties || {});
    console.log('props:', props.join(', ') || '(none)');
  }
  await client.close();
} catch (e) {
  console.error('PROBE ERROR:', e.message);
  process.exit(1);
}
process.exit(0);