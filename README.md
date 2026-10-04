# Apple Ads MCP

A small MCP server for Apple Ads. Plain JavaScript, two implementation files, no build step or database.

It supports the **Platform API v1** and **Campaign Management API v5**. Five tools expose help and the four JSON HTTP verbs. Campaigns, ad groups, keywords, negative keywords, ads, creatives, budgets, reports, insights, and other JSON endpoints use the same code.

## Start

Install Node.js 22 or later, then run:

```sh
npm ci
cp .env.example .env
# Fill in .env, then:
node --env-file=.env server.js
```

The server uses stdio: connect it from an MCP client. It does not display a web page. `npm start` also works if your client or shell supplies the environment variables.

### Apple credentials

Follow [Apple's OAuth setup](https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api) to create an API user and register a public key. You can generate the key pair with:

```sh
openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem
chmod 600 private-key.pem
```

Upload **public-key.pem** in Apple Ads → Account Settings → API. Set the returned client ID, team ID, key ID, and the absolute path to **private-key.pem** in `.env`. The server signs the client secret and fetches/refreshes the access token automatically. These are Apple Ads credentials, separate from App Store Connect credentials.

Alternatively, set `APPLE_ADS_ACCESS_TOKEN` to an existing bearer token. This takes precedence over signing credentials and cannot refresh itself.

You can connect and call help without credentials. The first API call authenticates. Start with `apple_ads_get` and `{"path":"/acls"}` to discover accessible accounts. Set `APPLE_ADS_ACCOUNT_ID` for v1, or pass `account_id` in calls. For v5, set `APPLE_ADS_API=v5` and `APPLE_ADS_ORG_ID`. You can also choose `api` per call; the two default account IDs stay separate.

### MCP client configuration

Use absolute paths so this works regardless of the client's working directory:

```json
{
  "mcpServers": {
    "apple-ads": {
      "command": "/absolute/path/to/node",
      "args": [
        "--env-file=/absolute/path/to/AppleAdsMCP/.env",
        "/absolute/path/to/AppleAdsMCP/server.js"
      ]
    }
  }
}
```

The client can supply variables through its `env` field instead of `--env-file`. Keep credentials out of committed configuration. `.env` and key files are ignored by Git.

## Tools

| Tool | Purpose |
| --- | --- |
| `apple_ads_help` | Local endpoint guide and example arguments; no Apple call |
| `apple_ads_get` | Read entities, apps, and account access |
| `apple_ads_post` | Queries, reports, creation, and bulk changes |
| `apple_ads_put` | Update an entity |
| `apple_ads_delete` | Delete an entity |

All HTTP tools accept `path`, optional `api`, optional `account_id`, and optional `query`. POST and PUT require `body`, which may be an object or an array. Paths exclude the API prefix; `/campaigns/123` is valid. Put query parameters in `query`, where arrays repeat a parameter. JSON is forwarded unchanged; the server does not invent required fields or change statuses.

Responses have `{ "status": 200, "body": <Apple response>, "rate_limit": {...} }`, available as both text and MCP structured content. HTTP errors set `isError` and preserve Apple's error body. Empty responses have `body: null`; non-JSON responses remain strings. Pagination, bulk item errors, and report totals stay inside `body` exactly as Apple returns them. A 2xx bulk response can contain failed items: check each item's result.

See [API.md](API.md) or call `apple_ads_help` for examples.

## Speed and predictable behavior

- Uses Node's pooled `fetch` connections. A warm tool call makes one API request.
- Caches the parsed signing key and access token. Concurrent calls share one token exchange.
- Does not cache API data, fetch extra pages, retry, queue, or add sleeps. Pagination, sorting, dates, and changes are explicit arguments.
- Each HTTP request has a 30-second timeout, configurable with `APPLE_ADS_TIMEOUT_MS` (1–120000). A cold call can require two requests: OAuth, then the API.
- A 401 invalidates the cached token for the next call. The failed call is never replayed. A 429 returns the rate-limit headers; the caller decides when to retry.
- Credentials go only to Apple's fixed hosts. Redirects and absolute/traversal paths are rejected. Logs go to stderr; stdout is exclusively MCP.

“Deterministic” describes request behavior, not Apple's changing data or network timing. Specify sorting when row order matters. Real response latency is largely Apple's network/API time; the benchmark measures local overhead separately.

## Change and verify

Read [client.js](client.js) for OAuth, tokens, validation, and HTTP. Read [server.js](server.js) for tool schemas and MCP responses. Adding a new Apple JSON endpoint needs no implementation change: use its path and documented payload. File uploads to external asset-upload URLs are outside these JSON tools.

```sh
npm test
npm run bench
```

Tests run offline with fake Apple responses and a real MCP client, including a stdio subprocess. The benchmark also uses fake responses, so it measures overhead rather than claiming Apple latency. No credentials or account changes are needed for either command. Actual Apple access depends on your credentials, role, and account eligibility.

Dependencies are pinned and `package-lock.json` is included; use `npm ci` for repeatable installation.
