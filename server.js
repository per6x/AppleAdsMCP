import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createAppleAdsClient } from './client.js';

export function createServer(client = createAppleAdsClient()) {
  const server = new McpServer({ name: 'apple-ads', version: '1.0.0' }, {
    instructions: `Apple Ads JSON API. Default API: ${client.defaultApi}. Call apple_ads_help for endpoints and examples. ` +
      'Use /acls to discover accounts. Supply explicit IDs, filters, sorting, pagination, and report dates. ' +
      'POST handles both queries/reports and creation/bulk changes. No retries or automatic pagination.',
  });

  server.registerTool('apple_ads_help', {
    description: 'Get Apple Ads endpoint paths, example calls, pagination rules, and API documentation links. No network call.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => ({
    content: [{ type: 'text', text: await readFile(new URL('./API.md', import.meta.url), 'utf8') }],
  }));

  const value = z.union([z.string(), z.number(), z.boolean()]);
  const common = {
    path: z.string().describe('API-relative path, e.g. /acls or /campaigns/123. Omit /v1 or /api/v5 and query parameters.'),
    api: z.enum(['v1', 'v5']).optional().describe('v1: Platform API. v5: Campaign Management API. Defaults to configured API.'),
    account_id: z.string().regex(/^\d+$/).optional().describe('v1 ad account ID or v5 organization ID; overrides the matching environment variable.'),
    query: z.record(z.string(), z.union([value, z.array(value)])).optional()
      .describe('URL parameters. Arrays repeat the parameter; values are URL-encoded.'),
  };

  // Four ordinary HTTP verbs keep the entire JSON API accessible without wrappers.
  const descriptions = {
    GET: 'Read Apple Ads accounts (/acls), apps, campaigns, ad groups, keywords, ads, creatives, and budgets by path.',
    POST: 'Query Apple Ads campaigns/ad groups/keywords, fetch reports and insights, or create entities and make bulk changes. See apple_ads_help.',
    PUT: 'Update an Apple Ads campaign, ad group, keyword, ad, creative, account, or budget by path with its exact JSON payload.',
    DELETE: 'Delete an Apple Ads entity by path. Apple may soft-delete it. This changes the account.',
  };
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    const schema = { ...common };
    if (method === 'POST' || method === 'PUT') {
      schema.body = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
        .describe('Exact Apple JSON request body. v5 bulk endpoints may require an array.');
    }
    server.registerTool(`apple_ads_${method.toLowerCase()}`, {
      description: descriptions[method],
      inputSchema: z.object(schema).strict(),
      annotations: {
        readOnlyHint: method === 'GET',
        destructiveHint: method !== 'GET',
        idempotentHint: method === 'GET',
        openWorldHint: true,
      },
    }, async (args) => {
      try {
        const result = await client.request(method, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: result.status < 200 || result.status >= 300,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await createServer().connect(new StdioServerTransport());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
