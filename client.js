import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const API_URLS = {
  v1: 'https://api.ads.apple.com/v1',
  v5: 'https://api.searchads.apple.com/api/v5',
};
const TOKEN_URL = 'https://appleid.apple.com/auth/oauth2/token';
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

// Dependencies are arguments only so tests can use a fake Apple server and clock.
export function createAppleAdsClient(env = process.env, fetch = globalThis.fetch, now = Date.now) {
  const defaultApi = env.APPLE_ADS_API || 'v1';
  const timeout = Number(env.APPLE_ADS_TIMEOUT_MS || 30000);
  if (!Object.hasOwn(API_URLS, defaultApi)) throw new Error('APPLE_ADS_API must be v1 or v5');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) {
    throw new Error('APPLE_ADS_TIMEOUT_MS must be an integer from 1 to 120000');
  }

  let privateKey;
  let token;
  let expiresAt = 0;
  let tokenRequest;

  async function send(url, options) {
    // Never follow redirects with credentials, retry writes, or hide extra API calls.
    const response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = text; }
    }
    return {
      status: response.status,
      body,
      rate_limit: {
        limit: response.headers.get('ratelimit-limit'),
        remaining: response.headers.get('ratelimit-remaining'),
        reset: response.headers.get('ratelimit-reset'),
        retry_after: response.headers.get('retry-after'),
      },
    };
  }

  async function refreshToken() {
    for (const name of ['CLIENT_ID', 'TEAM_ID', 'KEY_ID', 'PRIVATE_KEY_PATH']) {
      if (!env[`APPLE_ADS_${name}`]) throw new Error(`Missing APPLE_ADS_${name}`);
    }
    if (!privateKey) {
      const key = createPrivateKey(await readFile(env.APPLE_ADS_PRIVATE_KEY_PATH));
      if (key.asymmetricKeyType !== 'ec' ||
          key.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
        throw new Error('APPLE_ADS_PRIVATE_KEY_PATH must contain a P-256 EC private key');
      }
      privateKey = key;
    }

    const issuedAt = Math.floor(now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'ES256', kid: env.APPLE_ADS_KEY_ID });
    const claims = encode({
      iss: env.APPLE_ADS_TEAM_ID,
      sub: env.APPLE_ADS_CLIENT_ID,
      aud: 'https://appleid.apple.com',
      iat: issuedAt,
      exp: issuedAt + 86400,
    });
    const unsigned = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(unsigned), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const requestedAt = now();
    const result = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.APPLE_ADS_CLIENT_ID,
        client_secret: `${unsigned}.${signature}`,
        scope: 'searchadsorg',
      }).toString(),
    });
    if (result.status < 200 || result.status >= 300) {
      // Do not echo the auth response: it may contain credentials.
      throw new Error(`Apple OAuth HTTP ${result.status}. Check your API credentials and key.`);
    }
    const data = result.body;
    if (typeof data?.access_token !== 'string' || !data.access_token ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error('Apple OAuth returned an invalid access token or expires_in');
    }
    token = data.access_token;
    // Refresh just before expiry. Small TTLs still remain usable.
    expiresAt = requestedAt + data.expires_in * 1000 - Math.min(30000, data.expires_in * 100);
    return token;
  }

  async function accessToken() {
    if (env.APPLE_ADS_ACCESS_TOKEN) return env.APPLE_ADS_ACCESS_TOKEN;
    if (token && now() < expiresAt) return token;
    // Concurrent calls share one token exchange, including its failure.
    if (!tokenRequest) tokenRequest = refreshToken();
    const pending = tokenRequest;
    try { return await pending; }
    finally { if (tokenRequest === pending) tokenRequest = undefined; }
  }

  async function request(method, { path, api = defaultApi, account_id, query = {}, body } = {}) {
    if (!METHODS.includes(method)) throw new Error('Method must be GET, POST, PUT, or DELETE');
    if (!Object.hasOwn(API_URLS, api)) throw new Error('api must be v1 or v5');
    // Only API-relative paths. Query parameters belong in query, not in path.
    if (typeof path !== 'string' || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) {
      throw new Error('path must be an API-relative path such as /campaigns/123, without query parameters');
    }
    if ((method === 'GET' || method === 'DELETE') && body !== undefined) {
      throw new Error(`${method} does not accept a JSON body`);
    }
    const url = new URL(API_URLS[api] + path);
    for (const [name, value] of Object.entries(query)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (!['string', 'number', 'boolean'].includes(typeof item) ||
            (typeof item === 'number' && !Number.isFinite(item))) {
          throw new Error('query values must be strings, finite numbers, booleans, or arrays of them');
        }
        url.searchParams.append(name, String(item));
      }
    }
    const unscoped = method === 'GET' && (path === '/me' || path === '/acls' ||
      (api === 'v1' && (path === '/advertiser-resources' || /^\/orgs\/\d+$/.test(path)))) ||
      (api === 'v1' && method === 'POST' && path === '/ad-accounts');
    const account = account_id ?? (api === 'v1' ? env.APPLE_ADS_ACCOUNT_ID : env.APPLE_ADS_ORG_ID);
    if (!unscoped && (typeof account !== 'string' || !/^\d+$/.test(account))) {
      throw new Error(`Set ${api === 'v1' ? 'APPLE_ADS_ACCOUNT_ID' : 'APPLE_ADS_ORG_ID'} or pass account_id as a numeric string`);
    }
    const json = body === undefined ? undefined : JSON.stringify(body);
    const bearer = await accessToken();
    const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/json' };
    if (!unscoped) headers['X-AP-Context'] = `${api === 'v1' ? 'adAccountId' : 'orgId'}=${account}`;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const result = await send(url, { method, headers, body: json });
    // Report a 401 as received. The next call refreshes; this call is never replayed.
    if (result.status === 401) { token = undefined; expiresAt = 0; }
    return result;
  }

  return { request, defaultApi };
}
