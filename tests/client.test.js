import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppleAdsClient } from '../client.js';

const fixed = { APPLE_ADS_ACCESS_TOKEN: 'test-token', APPLE_ADS_ACCOUNT_ID: '123', APPLE_ADS_ORG_ID: '456' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
let directory, publicKey, credentials;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'apple-ads-test-'));
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  publicKey = keys.publicKey;
  const path = join(directory, 'private-key.pem');
  await writeFile(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  credentials = {
    APPLE_ADS_CLIENT_ID: 'SEARCHADS.client', APPLE_ADS_TEAM_ID: 'SEARCHADS.team',
    APPLE_ADS_KEY_ID: 'key-id', APPLE_ADS_PRIVATE_KEY_PATH: path,
    APPLE_ADS_ACCOUNT_ID: '123', APPLE_ADS_ORG_ID: '456',
  };
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

test('forwards JSON, repeated/encoded query values, and account context without extra pages', async () => {
  const calls = [];
  const body = { result: [{ id: 9 }], pagination: { offset: 20, pageSize: 20, totalCount: 100 } };
  const client = createAppleAdsClient(fixed, async (url, options) => {
    calls.push({ url: String(url), options });
    return json(body, 200, { 'RateLimit-Remaining': '4', 'Retry-After': '37' });
  });
  const query = { storeFronts: ['US', 'GB'], query: 'photo & edit', offset: 20, returnOwnedApps: true };
  const result = await client.request('GET', { path: '/search/apps', query });
  assert.deepEqual(result.body, body);
  assert.equal(result.rate_limit.remaining, '4');
  assert.equal(result.rate_limit.retry_after, '37');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.ads.apple.com/v1/search/apps');
  assert.deepEqual(url.searchParams.getAll('storeFronts'), ['US', 'GB']);
  assert.equal(url.searchParams.get('query'), 'photo & edit');
  assert.equal(url.searchParams.get('returnOwnedApps'), 'true');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.headers['X-AP-Context'], 'adAccountId=123');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, undefined);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(query.storeFronts, ['US', 'GB']);
});

test('v1 and v5 account defaults and explicit overrides remain separate', async () => {
  const calls = [];
  const client = createAppleAdsClient(fixed, async (url, options) => {
    calls.push([String(url), options.headers['X-AP-Context']]); return json({});
  });
  await client.request('GET', { path: '/campaigns', api: 'v5' });
  await client.request('GET', { path: '/campaigns/1' });
  await client.request('GET', { path: '/campaigns/1', api: 'v5', account_id: '789' });
  assert.deepEqual(calls, [
    ['https://api.searchads.apple.com/api/v5/campaigns', 'orgId=456'],
    ['https://api.ads.apple.com/v1/campaigns/1', 'adAccountId=123'],
    ['https://api.searchads.apple.com/api/v5/campaigns/1', 'orgId=789'],
  ]);
  const v5 = createAppleAdsClient({ ...fixed, APPLE_ADS_API: 'v5' }, async (url) => {
    assert.equal(String(url), 'https://api.searchads.apple.com/api/v5/campaigns'); return json({});
  });
  await v5.request('GET', { path: '/campaigns' });
});

test('account discovery and other unscoped endpoints work without an account', async () => {
  const calls = [];
  const client = createAppleAdsClient({ APPLE_ADS_ACCESS_TOKEN: 'test-token' }, async (url, options) => {
    calls.push(String(url)); assert.equal(options.headers['X-AP-Context'], undefined); return json({});
  });
  for (const api of ['v1', 'v5']) {
    for (const path of ['/acls', '/me']) await client.request('GET', { api, path });
  }
  for (const path of ['/orgs/1', '/advertiser-resources']) await client.request('GET', { path });
  await client.request('POST', { path: '/ad-accounts', body: { orgId: 1, name: 'Test' } });
  assert.equal(calls.length, 7);
  await assert.rejects(client.request('GET', { path: '/campaigns/1' }), /APPLE_ADS_ACCOUNT_ID/);
  await assert.rejects(client.request('GET', { path: '/campaigns', api: 'v5' }), /APPLE_ADS_ORG_ID/);
  assert.equal(calls.length, 7);
});

test('POST and PUT preserve bodies, including v5 bare-array bulk requests; DELETE handles 204', async () => {
  const calls = [];
  const client = createAppleAdsClient(fixed, async (url, options) => {
    calls.push(options);
    return options.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ result: {} }, 201);
  });
  const body = { timeRange: { start: '2026-09-01', end: '2026-09-07' }, pagination: { offset: 0, pageSize: 20 } };
  await client.request('POST', { path: '/reports/apps/campaigns/query', body });
  const bulk = [{ id: 42, bidAmount: { amount: '1.25', currency: 'USD' } }];
  await client.request('PUT', { api: 'v5', path: '/campaigns/1/adgroups/2/targetingkeywords/bulk', body: bulk });
  const deleted = await client.request('DELETE', { path: '/keywords/42' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body, JSON.stringify(body));
  assert.equal(calls[1].body, JSON.stringify(bulk));
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[2].headers['Content-Type'], undefined);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, null);
});

test('invalid arguments are rejected before authentication or network traffic', async () => {
  let calls = 0;
  const client = createAppleAdsClient({}, async () => { calls++; return json({}); });
  for (const path of ['https://other.test/a', '//other.test/a', '/a/../me', '/a/%2e%2e/me', '/a\\me', '/a?x=1', '/a#x', '/v1//me', '/']) {
    await assert.rejects(client.request('GET', { path }), /path must/);
  }
  for (const api of ['v2', '__proto__', 'constructor']) {
    await assert.rejects(client.request('GET', { api, path: '/acls' }), /api must/);
  }
  await assert.rejects(client.request('PATCH', { path: '/acls' }), /Method must/);
  await assert.rejects(client.request('GET', { path: '/acls', body: {} }), /does not accept/);
  for (const account_id of ['x', '1\r\nHeader: value', 123, '']) {
    await assert.rejects(client.request('GET', { path: '/campaigns/1', account_id }), /numeric string/);
  }
  for (const value of [null, {}, [null], Infinity]) {
    await assert.rejects(client.request('GET', { path: '/acls', query: { x: value } }), /query values/);
  }
  assert.equal(calls, 0);
  assert.throws(() => createAppleAdsClient({ APPLE_ADS_API: '__proto__' }), /APPLE_ADS_API/);
  for (const value of ['0', '-1', 'NaN', '1.5', '120001']) {
    assert.throws(() => createAppleAdsClient({ APPLE_ADS_TIMEOUT_MS: value }), /APPLE_ADS_TIMEOUT_MS/);
  }
});

test('HTTP errors, rate-limit headers, and non-JSON bodies are returned with no retry', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let calls = 0;
    const client = createAppleAdsClient(fixed, async () => {
      calls++; return json({ error: { code: 'TEST', message: 'Apple error' } }, status, { 'Retry-After': '5' });
    });
    const result = await client.request('POST', { path: '/campaigns', body: { name: 'Test' } });
    assert.equal(result.status, status);
    assert.equal(result.body.error.message, 'Apple error');
    assert.equal(result.rate_limit.retry_after, '5');
    assert.equal(calls, 1);
  }
  const client = createAppleAdsClient(fixed, async () => new Response('upstream unavailable', { status: 502 }));
  assert.equal((await client.request('GET', { path: '/acls' })).body, 'upstream unavailable');
});

test('OAuth JWT is verifiable ES256, shared across concurrent requests, reused and refreshed before expiry', async () => {
  let clock = 1791142074000, exchanges = 0, apiCalls = 0;
  const client = createAppleAdsClient(credentials, async (url, options) => {
    if (String(url).includes('appleid.apple.com')) {
      exchanges++;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(form.get('client_id'), credentials.APPLE_ADS_CLIENT_ID);
      assert.equal(form.get('scope'), 'searchadsorg');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const [header, payload, signature] = form.get('client_secret').split('.');
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'key-id' });
      const claims = JSON.parse(Buffer.from(payload, 'base64url'));
      assert.equal(claims.iss, credentials.APPLE_ADS_TEAM_ID);
      assert.equal(claims.sub, credentials.APPLE_ADS_CLIENT_ID);
      assert.equal(claims.aud, 'https://appleid.apple.com');
      assert.equal(claims.iat, Math.floor(clock / 1000));
      assert.equal(claims.exp - claims.iat, 86400);
      assert.equal(Buffer.from(signature, 'base64url').length, 64);
      assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
      await delay(5);
      return json({ access_token: `token-${exchanges}`, expires_in: 3600 });
    }
    apiCalls++;
    assert.equal(options.headers.Authorization, `Bearer token-${exchanges}`);
    return json({});
  }, () => clock);
  await Promise.all(Array.from({ length: 20 }, () => client.request('GET', { path: '/acls' })));
  assert.equal(exchanges, 1); assert.equal(apiCalls, 20);
  clock += 3569000;
  await client.request('GET', { path: '/acls' });
  assert.equal(exchanges, 1);
  clock += 1000;
  await client.request('GET', { path: '/acls' });
  assert.equal(exchanges, 2); assert.equal(apiCalls, 22);
});

test('401 invalidates the token for the next call, without replaying the failed write', async () => {
  let exchanges = 0, writes = 0;
  const client = createAppleAdsClient(credentials, async (url) => {
    if (String(url).includes('appleid.apple.com')) return json({ access_token: `token-${++exchanges}`, expires_in: 3600 });
    return json({}, ++writes === 1 ? 401 : 200);
  });
  assert.equal((await client.request('POST', { path: '/campaigns', body: {} })).status, 401);
  assert.equal(writes, 1); assert.equal(exchanges, 1);
  assert.equal((await client.request('POST', { path: '/campaigns', body: {} })).status, 200);
  assert.equal(writes, 2); assert.equal(exchanges, 2);
});

test('failed shared OAuth does not leak response secrets and can recover on the next call', async () => {
  let exchanges = 0, apiCalls = 0;
  const client = createAppleAdsClient(credentials, async (url) => {
    if (String(url).includes('appleid.apple.com')) {
      exchanges++;
      await delay(5);
      return exchanges === 1 ? json({ error: 'secret-that-must-not-appear' }, 400) : json({ access_token: 'fresh', expires_in: 3600 });
    }
    apiCalls++; return json({});
  });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => client.request('GET', { path: '/acls' })));
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /OAuth HTTP 400/);
    assert.doesNotMatch(result.reason.message, /secret-that/);
  }
  assert.equal(exchanges, 1); assert.equal(apiCalls, 0);
  await client.request('GET', { path: '/acls' });
  assert.equal(exchanges, 2); assert.equal(apiCalls, 1);
});

test('invalid OAuth responses never send invalid tokens to the API', async () => {
  for (const body of [{}, { access_token: '', expires_in: 3600 }, { access_token: 'token', expires_in: '3600' }, { access_token: 'token', expires_in: -1 }]) {
    let calls = 0;
    const client = createAppleAdsClient(credentials, async () => { calls++; return json(body); });
    await assert.rejects(client.request('GET', { path: '/acls' }), /invalid access token/);
    assert.equal(calls, 1);
  }
});

test('invalid signing keys are consistently rejected before network access', async () => {
  const path = join(directory, 'wrong-key.pem');
  const keys = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  await writeFile(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  let calls = 0;
  const client = createAppleAdsClient({ ...credentials, APPLE_ADS_PRIVATE_KEY_PATH: path }, async () => { calls++; return json({}); });
  for (let i = 0; i < 2; i++) await assert.rejects(client.request('GET', { path: '/acls' }), /P-256 EC/);
  assert.equal(calls, 0);
});

test('per-request timeout aborts a slow request and does not retry it', async () => {
  let calls = 0;
  const client = createAppleAdsClient({ ...fixed, APPLE_ADS_TIMEOUT_MS: '10' }, async (url, options) => {
    calls++;
    await delay(1000, undefined, { signal: options.signal });
    return json({});
  });
  await assert.rejects(client.request('GET', { path: '/acls' }), /aborted/);
  assert.equal(calls, 1);
});
