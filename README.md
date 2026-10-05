# @cradler/mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that
lets AI agents — Claude Desktop, Cursor, Claude Code, and any other MCP client —
read and write the data in a single [Cradler](https://cradler.ai) project.

It runs over **stdio** and exposes five tools backed by the Cradler data
gateway: `get_schema`, `query`, `insert`, `update` and `delete`.

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

| Tool         | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `get_schema` | Return a collection's columns (name → type). Use it to discover column names.    |
| `query`      | Read rows with optional filters, sorting, column projection and paging.         |
| `insert`     | Insert one or more rows. New collections and columns are created automatically. |
| `update`     | Patch every row matching the given filters (filters required).                  |
| `delete`     | Delete every row matching the given filters (filters required — never the lot).  |

### Filters

`query`, `update` and `delete` accept filter objects of the form
`{ field, op, value }`. Valid operators:

`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is_null`.

For `in`, `value` is an array; for `is_null`, `value` is a boolean. Every
other operator requires a `value` — a filter without one is rejected rather
than silently matching nulls.

`query` defaults to a `limit` of 100 rows (maximum 1000) so large tables are
not pulled in full. `update` and `delete` require a non-empty `filters` array — there is no
way to update or delete an entire collection in one call.

## Development

```sh
pnpm install
pnpm build       # bundle to dist/index.js with tsup
pnpm typecheck   # tsc --noEmit
pnpm dev         # rebuild on change
```

## License

MIT
