# Apple Ads tool guide

Start with `apple_ads_get` and `{"path":"/acls"}` to discover accessible accounts. Set a default account ID in the environment or pass `account_id` as a string. All paths below omit the API prefix. Select `api: "v1"` or `api: "v5"` explicitly when switching APIs. Their payloads and IDs are different; do not translate by changing only the version.

## Platform API v1

Base: `https://api.ads.apple.com/v1`. Scoped calls use `X-AP-Context: adAccountId=<account_id>`.

| Operation | Tool | Path |
| --- | --- | --- |
| Identity / accessible accounts | GET | `/me`, `/acls` |
| Organization / account | GET | `/orgs/{id}`, `/ad-accounts/{id}` |
| Find apps | GET | `/search/apps` |
| Query entities | POST | `/campaigns/query`, `/adgroups/query`, `/keywords/query` |
| Create entities | POST | `/campaigns`, `/adgroups`, `/keywords` |
| Read / update / delete an entity | GET / PUT / DELETE | `/campaigns/{id}`, `/adgroups/{id}`, `/keywords/{id}` |
| Bulk keyword changes | POST | `/keywords/bulk-create`, `/keywords/bulk-update`, `/keywords/bulk-delete` |
| App campaign report | POST | `/reports/apps/campaigns/query` |
| Search term popularity | POST | `/insights/apps/search-term-popularity/query` |

GET `/me`, `/acls`, `/orgs/{id}`, `/advertiser-resources`, and POST `/ad-accounts` do not need an account header. The server omits it for these calls.

The tool names are `apple_ads_get`, `apple_ads_post`, `apple_ads_put`, and `apple_ads_delete`. Replace the example IDs and dates with your own.

**Find owned apps** — `apple_ads_get`:

```json
{"api":"v1","path":"/search/apps","account_id":"123456789","query":{"returnOwnedApps":true,"storeFronts":["US","GB"],"limit":20,"offset":0}}
```

**List campaigns** — `apple_ads_post`:

```json
{
  "api": "v1",
  "path": "/campaigns/query",
  "account_id": "123456789",
  "body": {
    "sorting": [{"field":"creationTime","order":"DESC"}],
    "pagination": {"offset":0,"pageSize":20,"fetchTotalCount":true}
  }
}
```

**List an ad group's keywords** — `apple_ads_post`:

```json
{
  "api": "v1",
  "path": "/keywords/query",
  "account_id": "123456789",
  "body": {
    "filters": [{"field":"adGroupId","operator":"EQUALS","value":456789123}],
    "sorting": [{"field":"creationTime","order":"DESC"}],
    "pagination": {"offset":0,"pageSize":20,"fetchTotalCount":true}
  }
}
```

For ad groups, use `/adgroups/query` with a `campaignId` filter.

**Report daily campaign performance** — `apple_ads_post`:

```json
{
  "api": "v1",
  "path": "/reports/apps/campaigns/query",
  "account_id": "123456789",
  "body": {
    "filters": [{"field":"campaignId","operator":"EQUALS","value":"234567891"}],
    "timeRange": {"start":"2026-09-01","end":"2026-09-07","timeZone":"ORTZ","granularity":"DAILY"},
    "groupBy": ["countryOrRegion"],
    "pagination": {"offset":0,"pageSize":20}
  }
}
```

**Pause a campaign** — `apple_ads_put`:

```json
{"api":"v1","path":"/campaigns/234567891","account_id":"123456789","body":{"status":"PAUSED"}}
```

**Change multiple keyword bids** — `apple_ads_post`:

```json
{
  "api": "v1",
  "path": "/keywords/bulk-update",
  "account_id": "123456789",
  "body": {
    "items": [
      {"correlationId":0,"data":{"id":567891234,"bid":{"amount":"1.25","currency":"USD"}}},
      {"correlationId":1,"data":{"id":678912345,"bid":{"amount":"1.50","currency":"USD"}}}
    ]
  }
}
```

Money amounts remain decimal strings. Bulk changes use one request; inspect every returned item. Creation, negative keywords, ads, creatives, Maps campaigns, budgets, recommendations, and other endpoints use the same tools with their documented payloads.

## Campaign Management API v5

Base: `https://api.searchads.apple.com/api/v5`. Scoped calls use `X-AP-Context: orgId=<account_id>`. The environment default is `APPLE_ADS_ORG_ID`.

Common paths: GET `/campaigns`, GET `/campaigns/{campaignId}/adgroups`, GET `/campaigns/{campaignId}/adgroups/{adGroupId}/targetingkeywords`; POST `/reports/campaigns`; PUT `/campaigns/{campaignId}`. GET `/me` and `/acls` omit the organization header.

**List campaigns** — `apple_ads_get`:

```json
{"api":"v5","path":"/campaigns","account_id":"123456789","query":{"limit":20,"offset":0}}
```

**Campaign report** — `apple_ads_post`:

```json
{
  "api": "v5",
  "path": "/reports/campaigns",
  "account_id": "123456789",
  "body": {
    "startTime": "2026-09-01",
    "endTime": "2026-09-07",
    "granularity": "DAILY",
    "timeZone": "UTC",
    "selector": {
      "orderBy": [{"field":"campaignId","sortOrder":"ASCENDING"}],
      "pagination": {"offset":0,"limit":20}
    },
    "returnRowTotals": true,
    "returnGrandTotals": true
  }
}
```

v5 bulk endpoints can require a bare array; pass that array as `body`.

## Results and pagination

Every HTTP tool returns `{status, body, rate_limit}`. `body` is Apple's unmodified response. A normal v1 query includes `body.result` and `body.pagination`. v5 uses its own response shape. Read Apple's pagination, increase the offset explicitly, and keep your filters and sorting identical for subsequent pages. Never treat one page as all results.

HTTP failures are MCP tool errors with Apple's status/body. A timeout or lost connection after a write leaves its outcome uncertain: read the entity before deciding whether to submit another write. The server does not replay any call. For 429, use `rate_limit.retry_after`, or `rate_limit.reset` when absent. For bulk operations, check per-item success even when the HTTP status is 2xx.

## Official references

- [Platform API](https://developer.apple.com/documentation/apple-ads-platform-api)
- [OAuth](https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api)
- [Account access](https://developer.apple.com/documentation/apple-ads-platform-api/access-overview)
- [Campaigns](https://developer.apple.com/documentation/apple-ads-platform-api/campaigns-endpoints)
- [Keywords](https://developer.apple.com/documentation/apple-ads-platform-api/keywords-endpoints)
- [Reports](https://developer.apple.com/documentation/apple-ads-platform-api/apps-reports-endpoints)
- [Bulk operations](https://developer.apple.com/documentation/apple-ads-platform-api/bulk-operations-endpoints)
- [Campaign Management API v5](https://developer.apple.com/documentation/apple_ads)
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
