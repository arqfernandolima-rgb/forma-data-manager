// Smoke test: start the server over stdio as a real MCP client would, call every tool, report sizes.
// Usage: bun scripts/smoke.js <dataDir> [serverCommand...]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const dataDir = process.argv[2];
const cmd = process.argv.slice(3);
const transport = new StdioClientTransport({
  command: cmd[0] || process.execPath,
  args: cmd.length ? cmd.slice(1) : [new URL('../src/cli.js', import.meta.url).pathname, 'serve'],
  env: { ...process.env, FORMA_DATA_DIR: dataDir },
  stderr: 'pipe',
});
transport.stderr?.on('data', (d) => process.stderr.write(`  [server] ${d}`));
const client = new Client({ name: 'smoke', version: '1.0.0' });
const t0 = Date.now();
await client.connect(transport);
console.log(`connected in ${Date.now() - t0} ms; instructions: ${client.getInstructions()?.length ?? 0} chars`);
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const { prompts } = await client.listPrompts();
console.log('prompts:', prompts.map((p) => p.name).join(', '));
await new Promise((r) => setTimeout(r, 400));
const calls = JSON.parse(process.env.SMOKE_CALLS || '[]');
const results = {};
for (const [name, args] of calls) {
  const s = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const txt = res.content.map((c) => c.text).join('');
  const ms = Date.now() - s;
  let parsed; try { parsed = JSON.parse(txt); } catch { parsed = txt; }
  results[`${name} ${JSON.stringify(args)}`] = { ms, chars: txt.length, preview: txt.slice(0, 600) };
  console.log(`\n## ${name} ${JSON.stringify(args)}  →  ${txt.length} chars, ${ms} ms\n${txt.slice(0, Number(process.env.SMOKE_PREVIEW || 500))}`);
}
const p = await client.getPrompt({ name: 'forma_dashboard', arguments: { request: 'RFI aging' } });
console.log(`\nprompt forma_dashboard → ${p.messages[0].content.text.length} chars`);
await client.close();
