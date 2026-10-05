#!/usr/bin/env node
/**
 * Cradler MCP server.
 *
 * An MCP (Model Context Protocol) server over stdio that lets AI agents
 * (Claude Desktop, Cursor, Claude Code, …) read and write the data in a
 * single Cradler project.
 *
 * Configured entirely through three environment variables:
 *   CRADLER_API_URL     — gateway base URL, e.g. https://gateway.cradler.ai
 *   CRADLER_PROJECT_ID  — project slug
 *   CRADLER_API_KEY     — project API key (anon or service)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { CradlerClient, CradlerError, describeError } from './cradler.js'

/** Read and validate the three required environment variables. */
function loadConfig(): { url: string; projectId: string; apiKey: string } {
  const url = process.env.CRADLER_API_URL
  const projectId = process.env.CRADLER_PROJECT_ID
  const apiKey = process.env.CRADLER_API_KEY

  const missing: string[] = []
  if (!url) missing.push('CRADLER_API_URL')
  if (!projectId) missing.push('CRADLER_PROJECT_ID')
  if (!apiKey) missing.push('CRADLER_API_KEY')

  if (missing.length > 0) {
    process.stderr.write(
      `cradler-mcp: missing required environment variable(s): ${missing.join(', ')}\n` +
        'Set CRADLER_API_URL, CRADLER_PROJECT_ID and CRADLER_API_KEY, then retry.\n',
    )
    process.exit(1)
  }

  return { url: url!, projectId: projectId!, apiKey: apiKey! }
}

/** Zod shape for a single gateway filter. */
const filterShape = z.object({
  field: z.string().describe('Column name to filter on.'),
  op: z
    .enum([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'like',
      'ilike',
      'in',
      'is_null',
    ])
    .describe('Comparison operator.'),
  value: z
    .unknown()
    .optional()
    .describe(
      'Comparison value. An array for `in`; a boolean for `is_null`; omitted is allowed only for `is_null`.',
    ),
})

/** Zod shape for a single order-by clause. */
const orderShape = z.object({
  field: z.string().describe('Column name to sort by.'),
  desc: z.boolean().describe('Sort descending when true, ascending when false.'),
})

/** A tool result containing a pretty-printed JSON payload. */
function ok(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
  }
}

/** An error tool result, with `isError` set so the agent can react. */
function fail(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  }
}

/** Run an operation and convert any CradlerError into an error tool result. */
async function guard(run: () => Promise<unknown>) {
  try {
    return ok(await run())
  } catch (err) {
    if (err instanceof CradlerError) {
      // Includes the gateway's per-field validation detail and the request
      // id (what makes a failure findable in the gateway's log).
      return fail(describeError(err))
    }
    return fail(`Unexpected error: ${(err as Error).message}`)
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const cradler = new CradlerClient(config)

  const server = new McpServer({
    name: 'cradler-mcp',
    version: '0.2.1',
  })

  server.registerTool(
    'get_schema',
    {
      title: 'Get collection schema',
      description:
        'Return the columns (name -> type) of a Cradler collection. ' +
        'Call this first to discover the exact column names before querying ' +
        'or writing data.',
      inputSchema: {
        collection: z.string().describe('Name of the collection (table).'),
      },
    },
    ({ collection }) => guard(() => cradler.getSchema(collection)),
  )

  server.registerTool(
    'query',
    {
      title: 'Query rows',
      description:
        'Read rows from a Cradler collection with optional filtering, ' +
        'sorting, column projection and paging. Defaults to a limit of 100 ' +
        'rows so large tables are not pulled in full. `count` in the result ' +
        'is the size of the page returned, NOT how many rows matched — to ' +
        'answer "how many are there", pass countTotal: true and read `total`.',
      inputSchema: {
        collection: z.string().describe('Name of the collection to read.'),
        filters: z
          .array(filterShape)
          .optional()
          .describe('Filters; all must match (AND). Omit to match every row.'),
        order: z
          .array(orderShape)
          .optional()
          .describe('Sort order, applied in the given sequence.'),
        select: z
          .array(z.string())
          .optional()
          .describe('Columns to return. Omit to return all columns.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe('Maximum rows to return (1–1000). Defaults to 100.'),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Number of rows to skip, for paging.'),
        countTotal: z
          .boolean()
          .optional()
          .describe(
            'Also return `total`: how many rows match the filters overall, ' +
              'ignoring limit/offset. Use this to answer "how many" ' +
              'questions — `count` only ever reports the page size. Costs an ' +
              'extra counting pass, so leave it off when paging through data.',
          ),
      },
    },
    ({ collection, filters, order, select, limit, offset, countTotal }) =>
      guard(() =>
        cradler.query(collection, {
          filters,
          order,
          select,
          limit: limit ?? 100,
          offset,
          count: countTotal ? 'exact' : undefined,
        }),
      ),
  )

  server.registerTool(
    'insert',
    {
      title: 'Insert rows',
      description:
        'Insert one or more rows into a Cradler collection. The collection ' +
        'and any new columns are created automatically. Pass field names ' +
        'exactly as the collection stores them (typically snake_case).',
      inputSchema: {
        collection: z
          .string()
          .describe('Name of the collection to insert into.'),
        rows: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .describe('Array of row objects to insert.'),
      },
    },
    ({ collection, rows }) => guard(() => cradler.insert(collection, rows)),
  )

  server.registerTool(
    'update',
    {
      title: 'Update rows',
      description:
        'Update every row in a Cradler collection that matches the given ' +
        'filters, applying the same patch to each. Filters are required and ' +
        'must be non-empty.',
      inputSchema: {
        collection: z.string().describe('Name of the collection to update.'),
        patch: z
          .record(z.string(), z.unknown())
          .describe('Object of column -> new value to apply to matched rows.'),
        filters: z
          .array(filterShape)
          .min(1)
          .describe('Filters selecting which rows to update (required).'),
      },
    },
    ({ collection, patch, filters }) =>
      guard(() => cradler.update(collection, patch, filters)),
  )

  server.registerTool(
    'delete',
    {
      title: 'Delete rows',
      description:
        'Delete every row in a Cradler collection that matches the given ' +
        'filters. Filters are required and must be non-empty — deleting an ' +
        'entire collection is not allowed.',
      inputSchema: {
        collection: z
          .string()
          .describe('Name of the collection to delete from.'),
        filters: z
          .array(filterShape)
          .min(1)
          .describe('Filters selecting which rows to delete (required).'),
      },
    },
    ({ collection, filters }) =>
      guard(() => cradler.delete(collection, filters)),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(
    `cradler-mcp: connected (project ${config.projectId} @ ${config.url})\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`cradler-mcp: fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
