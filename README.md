# @cradler/mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that
lets AI agents — Claude Desktop, Cursor, Claude Code, and any other MCP client —
read and write the data in a single [Cradler](https://cradler.ai) project.

It runs over **stdio** and exposes seven tools backed by the Cradler data
gateway: `list_collections`, `get_schema`, `query`, `aggregate`, `insert`,
`update` and `delete`.

## Configuration

The server is configured entirely through three environment variables:

| Variable             | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `CRADLER_API_URL`    | Gateway base URL, e.g. `https://gateway.cradler.ai`    |
| `CRADLER_PROJECT_ID` | Your project slug                                      |
| `CRADLER_API_KEY`    | A project API key (`anon` or `service`)                |

If any are missing, the server exits immediately with a clear error message.

You can find these values in the Cradler dashboard, on your project's page.

## Adding it to an AI tool

MCP clients are configured with an `mcpServers` block. Add an entry that runs
`@cradler/mcp` and passes your project's credentials as `env`:

```json
{
  "mcpServers": {
    "cradler": {
      "command": "npx",
      "args": ["-y", "@cradler/mcp"],
      "env": {
        "CRADLER_API_URL": "https://gateway.cradler.ai",
        "CRADLER_PROJECT_ID": "your-project-slug",
        "CRADLER_API_KEY": "your-project-api-key"
      }
    }
  }
}
```

Where this JSON lives depends on the tool:

- **Claude Desktop** — `claude_desktop_config.json`
  (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`).
- **Cursor** — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project).
- **Claude Code** — `claude mcp add`, or a `.mcp.json` file in the project root.

After saving, restart the tool. The agent will then have the Cradler tools.

### Running a local build instead

If you have cloned this repo and run `pnpm build`, you can point the client at
the built file directly:

```json
{
  "mcpServers": {
    "cradler": {
      "command": "node",
      "args": ["/absolute/path/to/cradler-mcp/dist/index.js"],
      "env": {
        "CRADLER_API_URL": "https://gateway.cradler.ai",
        "CRADLER_PROJECT_ID": "your-project-slug",
        "CRADLER_API_KEY": "your-project-api-key"
      }
    }
  }
}
```

## Tools

| Tool               | What it does                                                                    |
| ------------------ | ------------------------------------------------------------------------------- |
| `list_collections` | List every collection with its columns. Use it to discover what exists.         |
| `get_schema`       | Return one collection's columns (name → type).                                  |
| `query`            | Read rows with optional filters, sorting, column projection and paging.         |
| `aggregate`        | count / sum / avg / min / max over every matching row, optionally grouped.      |
| `insert`           | Insert one or more rows. New collections and columns are created automatically. |
| `update`           | Patch every row matching the given filters (filters required).                  |
| `delete`           | Delete every row matching the given filters (filters required — never the lot). |

### Filters

`query`, `aggregate`, `update` and `delete` accept filter objects of the form
`{ field, op, value }`. Valid operators:

`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is_null`.

For `in`, `value` is an array; for `is_null`, `value` is a boolean. Every
other operator requires a `value` — a filter without one is rejected rather
than silently matching nulls.

`query` defaults to a `limit` of 100 rows (maximum 1000) so large tables are
not pulled in full. Because of that cap, never compute a statistic from
`query` rows — use `aggregate`, which runs in the database over every matching
row:

```json
{
  "collection": "orders",
  "groupBy": ["status"],
  "aggregates": [
    { "fn": "count" },
    { "fn": "sum", "field": "amount", "as": "revenue" }
  ],
  "filters": [{ "field": "created_at", "op": "gte", "value": "2026-01-01" }]
}
```

Each result row holds the `groupBy` fields plus one key per aggregate — its
`as`, or `count` / `<fn>_<field>` (`sum_amount`) by default. `sum` and `avg`
need a numeric field; `min` and `max` a number, text, date or time. `limit`
(default 100, max 1000) caps the number of groups returned, not the rows
aggregated.

`update` and `delete` require a non-empty `filters` array — there is no way
to update or delete an entire collection in one call.

## Development

```sh
pnpm install
pnpm build       # bundle to dist/index.js with tsup
pnpm typecheck   # tsc --noEmit
pnpm dev         # rebuild on change
```

## License

MIT
