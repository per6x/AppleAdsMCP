import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';
import { createAppleAdsClient } from '../client.js';

async function connect(t, fetch) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(createAppleAdsClient({ APPLE_ADS_ACCESS_TOKEN: 'offline-token', APPLE_ADS_ACCOUNT_ID: '123', APPLE_ADS_ORG_ID: '456' }, fetch));
  const client = new Client({ name: 'apple-ads-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(b);
  await client.connect(a);
  return client;
}

test('MCP discovers five tools with correct schemas, descriptions and annotations', async (t) => {
  const client = await connect(t, async () => { throw new Error('help must not call Apple'); });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name), ['apple_ads_help', 'apple_ads_get', 'apple_ads_post', 'apple_ads_put', 'apple_ads_delete']);
  for (const tool of tools) assert.ok(tool.description);
  assert.equal(tools[1].annotations.readOnlyHint, true);
  assert.equal(tools[2].annotations.readOnlyHint, false);
  assert.equal(tools[4].annotations.destructiveHint, true);
  assert.ok(tools[2].inputSchema.required.includes('body'));
  const help = await client.callTool({ name: 'apple_ads_help', arguments: {} });
  assert.match(help.content[0].text, /reports\/apps\/campaigns\/query/);
  assert.match(help.content[0].text, /Campaign Management API v5/);
});

test('MCP executes read, query/report, create, update, bulk, and delete flows through the client', async (t) => {
  const calls = [];
  const client = await connect(t, async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ result: { id: 1 }, pagination: { offset: 0, pageSize: 20 } }), { status: 200 });
  });
  const cases = [
    ['apple_ads_get', { path: '/acls' }],
    ['apple_ads_post', { path: '/campaigns/query', body: { pagination: { offset: 0, pageSize: 20 } } }],
    ['apple_ads_post', { path: '/reports/apps/campaigns/query', body: { timeRange: { start: '2026-09-01', end: '2026-09-07' } } }],
    ['apple_ads_post', { path: '/campaigns', body: { name: 'Campaign', status: 'PAUSED' } }],
    ['apple_ads_put', { path: '/campaigns/1', body: { status: 'PAUSED' } }],
    ['apple_ads_post', { path: '/keywords/bulk-update', body: { items: [{ correlationId: 0, data: { id: 2, status: 'PAUSED' } }] } }],
    ['apple_ads_put', { path: '/campaigns/1/adgroups/2/targetingkeywords/bulk', api: 'v5', body: [{ id: 3, status: 'PAUSED' }] }],
    ['apple_ads_delete', { path: '/campaigns/1' }],
  ];
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  assert.equal(calls.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    assert.equal(calls[i].method.toLowerCase(), cases[i][0].replace('apple_ads_', ''));
    assert.equal(calls[i].body, cases[i][1].body === undefined ? undefined : JSON.stringify(cases[i][1].body));
  }
});

test('MCP preserves HTTP error details and validates arguments before network access', async (t) => {
  let calls = 0;
  const client = await connect(t, async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'invalid campaign' } }), { status: 400 });
  });
  const result = await client.callTool({ name: 'apple_ads_post', arguments: { path: '/campaigns', body: {} } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 400);
  assert.equal(result.structuredContent.body.error.message, 'invalid campaign');
  for (const args of [{ path: 'https://other.test' }, { path: '/acls', account_id: 'bad' }, { path: '/acls', unexpected: true }]) {
    const invalid = await client.callTool({ name: 'apple_ads_get', arguments: args });
    assert.equal(invalid.isError, true);
  }
  const missing = await client.callTool({ name: 'apple_ads_put', arguments: { path: '/campaigns/1' } });
  assert.equal(missing.isError, true);
  assert.equal(calls, 1);
});

test('stdio subprocess initializes, serves help without credentials, and reports missing credentials as a tool error', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server.js', import.meta.url))],
    env: { APPLE_ADS_API: 'v1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  const help = await client.callTool({ name: 'apple_ads_help', arguments: {} });
  assert.ok(help.content[0].text.startsWith('# Apple Ads tool guide'));
  const result = await client.callTool({ name: 'apple_ads_get', arguments: { path: '/acls' } });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Missing APPLE_ADS_CLIENT_ID');
});
