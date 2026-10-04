import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { fileURLToPath } from 'node:url';
import { createAppleAdsClient } from './client.js';
import { createServer } from './server.js';

const calls = 2000;
let apiCalls = 0;
const apple = createAppleAdsClient({ APPLE_ADS_ACCESS_TOKEN: 'benchmark', APPLE_ADS_ACCOUNT_ID: '123' }, async () => {
  apiCalls++;
  return new Response('{"result":[{"id":1}],"pagination":{"offset":0,"pageSize":20}}');
});
const [a, b] = InMemoryTransport.createLinkedPair();
const server = createServer(apple);
const client = new Client({ name: 'benchmark', version: '1.0.0' });
await server.connect(b);
await client.connect(a);

try {
  const run = () => client.callTool({ name: 'apple_ads_get', arguments: { path: '/campaigns/1' } });
  for (let i = 0; i < 100; i++) await run();
  const timings = [];
  const start = performance.now();
  for (let i = 0; i < calls; i++) {
    const before = performance.now();
    const result = await run();
    if (result.isError) throw new Error(JSON.stringify(result));
    timings.push(performance.now() - before);
  }
  const elapsed = performance.now() - start;
  timings.sort((x, y) => x - y);
  console.log('Local MCP round trip + Apple client + fake JSON response (no network):');
  console.log(JSON.stringify({
    calls, api_requests: apiCalls - 100,
    mean_ms: Number((elapsed / calls).toFixed(3)),
    p50_ms: Number(timings[Math.floor(calls * 0.50)].toFixed(3)),
    p95_ms: Number(timings[Math.floor(calls * 0.95)].toFixed(3)),
  }, null, 2));
} finally {
  await client.close();
  await server.close();
}

const startup = performance.now();
const stdio = new Client({ name: 'startup-benchmark', version: '1.0.0' });
try {
  await stdio.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.js', import.meta.url))],
    env: { APPLE_ADS_API: 'v1' },
    stderr: 'pipe',
  }));
  const { tools } = await stdio.listTools();
  console.log(`Stdio spawn + initialize + discover ${tools.length} tools: ${(performance.now() - startup).toFixed(1)} ms`);
} finally {
  await stdio.close();
}
