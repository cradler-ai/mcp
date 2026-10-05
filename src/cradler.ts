/**
 * A tiny, self-contained HTTP client for the Cradler data gateway.
 *
 * This intentionally does not depend on `@cradler/sdk` — the MCP server only
 * needs the handful of endpoints below, so it ships its own minimal client.
 */

/** The valid filter operators the gateway accepts. */
export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'is_null'

export interface Filter {
  field: string
  op: FilterOp
  value?: unknown
}

export interface OrderBy {
  field: string
  desc: boolean
}

/** A generic data row. */
export type Row = Record<string, unknown>

/** The result of any query / insert / update / delete. */
export interface ResultSet {
  rows: Row[]
  /** How many rows are in `rows`. Bounded by `limit`, so this is a page size,
   *  not an answer to "how many are there" — see `total`. */
  count: number
  /** How many rows match the filters in total, ignoring limit/offset. Only
   *  present when the query asked for it. */
  total?: number
}

/** The columns a collection currently has (auto-evolved by the gateway). */
export interface SchemaResult {
  collection: string
  columns: Record<string, string>
}

export interface QueryArgs {
  select?: string[]
  filters?: Filter[]
  order?: OrderBy[]
  limit?: number
  offset?: number
  /** `'exact'` also returns `total`, the number of rows matching the filters
   *  regardless of paging. Costs a second counting pass. */
  count?: 'exact'
}

/** Thrown for any non-2xx response (or transport failure) from the gateway. */
export class CradlerError extends Error {
  /** Machine-readable code, e.g. `schema_conflict`, `unauthorized`. */
  readonly code: string
  /** HTTP status (0 for network-level failures). */
  readonly status: number
  /** The gateway's id for this request. It appears in the server-side log
   *  too, so quoting it is what makes a reported failure findable. */
  readonly requestId?: string
  /** Structured detail — for `invalid_request`, the per-field validation
   *  errors that say which argument was wrong and why. */
  readonly details?: unknown

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    details?: unknown,
  ) {
    super(message)
    this.name = 'CradlerError'
    this.code = code
    this.status = status
    this.requestId = requestId
    this.details = details
    Object.setPrototypeOf(this, CradlerError.prototype)
  }
}

export interface CradlerClientOptions {
  /** Gateway base URL, e.g. `https://gateway.cradler.ai`. */
  url: string
  /** Project identifier (slug). */
  projectId: string
  /** Project API key (`anon` or `service`). */
  apiKey: string
}

/** Minimal client for the Cradler data gateway HTTP contract. */
export class CradlerClient {
  private readonly base: string
  private readonly apiKey: string

  constructor(options: CradlerClientOptions) {
    const url = options.url.replace(/\/+$/, '')
    this.base = `${url}/v1/${encodeURIComponent(options.projectId)}`
    this.apiKey = options.apiKey
  }

  /** `GET /{collection}/schema` — the collection's current columns. */
  getSchema(collection: string): Promise<SchemaResult> {
    return this.request<SchemaResult>('GET', `/${enc(collection)}/schema`)
  }

  /** `POST /{collection}/query` — read rows with filters / order / paging. */
  async query(collection: string, args: QueryArgs): Promise<ResultSet> {
    checkFilters(args.filters ?? [])
    return this.request<ResultSet>('POST', `/${enc(collection)}/query`, {
      select: args.select,
      filters: args.filters ?? [],
      order: args.order ?? [],
      limit: args.limit,
      offset: args.offset,
      ...(args.count !== undefined ? { count: args.count } : {}),
    })
  }

  /** `POST /{collection}` — insert one or more rows. */
  insert(collection: string, rows: Row[]): Promise<ResultSet> {
    return this.request<ResultSet>('POST', `/${enc(collection)}`, rows)
  }

  /** `POST /{collection}/update` — patch all rows matching the filters. */
  async update(
    collection: string,
    patch: Row,
    filters: Filter[],
  ): Promise<ResultSet> {
    checkFilters(filters)
    return this.request<ResultSet>('POST', `/${enc(collection)}/update`, {
      patch,
      filters,
    })
  }

  /** `POST /{collection}/delete` — delete all rows matching the filters. */
  async delete(collection: string, filters: Filter[]): Promise<ResultSet> {
    checkFilters(filters)
    return this.request<ResultSet>('POST', `/${enc(collection)}/delete`, {
      filters,
    })
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { apikey: this.apiKey }
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (cause) {
      throw new CradlerError(
        0,
        'network_error',
        `request to cradler gateway failed: ${(cause as Error).message}`,
      )
    }

    const raw = await response.text()
    let parsed: unknown
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new CradlerError(
          response.status,
          response.ok ? 'bad_response' : 'http_error',
          response.ok
            ? 'the gateway returned a non-JSON response'
            : `HTTP ${response.status}`,
        )
      }
    }

    if (!response.ok) {
      const error = (parsed as { error?: unknown } | undefined)?.error
      if (isErrorBody(error)) {
        throw new CradlerError(
          response.status,
          error.code,
          error.message,
          typeof error.request_id === 'string' ? error.request_id : undefined,
          error.details,
        )
      }
      throw new CradlerError(
        response.status,
        'http_error',
        `HTTP ${response.status}`,
      )
    }

    return parsed as T
  }
}

/**
 * Refuse a comparison filter with no `value`. The gateway reads a missing
 * value as null, so `{op: 'neq', field: 'status'}` would quietly become
 * `status IS NOT NULL` — on `delete`, every row that has any status at all.
 * Only `is_null` may omit it.
 */
function checkFilters(filters: Filter[]): void {
  for (const f of filters) {
    if (f.op !== 'is_null' && f.value === undefined) {
      throw new CradlerError(
        0,
        'invalid_filter',
        `filter on '${f.field}' with op '${f.op}' has no value. Every op ` +
          `except is_null needs one; to match nulls use ` +
          `{op: 'is_null', value: true} (or value: false for not-null).`,
      )
    }
  }
}

/**
 * One line an agent can act on. For a request the gateway rejected as
 * malformed, the top-level message is only "request body failed validation";
 * the field and the reason are in `details`, so spell those out.
 */
export function describeError(err: CradlerError): string {
  let text = `Cradler error [${err.code}]: ${err.message}`
  if (Array.isArray(err.details) && err.details.length > 0) {
    const parts = err.details.slice(0, 5).map((d) => {
      const item = (d ?? {}) as { loc?: unknown; msg?: unknown }
      const loc = Array.isArray(item.loc)
        ? item.loc.filter((p) => p !== 'body').join('.')
        : ''
      const msg = typeof item.msg === 'string' ? item.msg : JSON.stringify(d)
      return loc ? `${loc}: ${msg}` : msg
    })
    text += ` — ${parts.join('; ')}`
  }
  if (err.requestId) text += ` (request ${err.requestId})`
  return text
}

function enc(collection: string): string {
  return encodeURIComponent(collection)
}

function isErrorBody(
  v: unknown,
): v is {
  code: string
  message: string
  request_id?: string
  details?: unknown
} {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  return typeof obj.code === 'string' && typeof obj.message === 'string'
}
