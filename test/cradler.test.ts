/**
 * The MCP server ships its own HTTP client rather than depending on the SDK,
 * which means the gateway's wire contract is duplicated here and can drift
 * from it silently. These tests pin down the parts of that contract an AI
 * agent's answers depend on: what goes out on the wire, and how a failure
 * comes back.
 *
 * `fetch` is stubbed, so no gateway is needed.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { CradlerClient, CradlerError } from '../src/cradler'

type Captured = { url: string; init: RequestInit }

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Stub fetch, capturing the outgoing request and replying with `reply`. */
function stub(reply: { status?: number; body: unknown }): Captured[] {
  const calls: Captured[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

function client() {
  return new CradlerClient({
    url: 'https://gateway.example/',
    projectId: 'proj',
    apiKey: 'k',
  })
}

function bodyOf(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.init.body))
}

describe('query', () => {
  it('asks for a total only when requested', async () => {
    const calls = stub({ body: { rows: [], count: 0 } })
    await client().query('users', { limit: 10 })
    assert.equal(bodyOf(calls[0]).count, undefined)

    const withCount = stub({ body: { rows: [], count: 0, total: 42 } })
    const result = await client().query('users', { limit: 10, count: 'exact' })
    assert.equal(bodyOf(withCount[0]).count, 'exact')
    assert.equal(result.total, 42)
  })

  it('reports the page size and the total as different numbers', async () => {
    // The distinction that matters: an agent asked "how many users are
    // there?" must not answer with the size of the page it happened to get.
    stub({ body: { rows: [{}, {}], count: 2, total: 500 } })
    const result = await client().query('users', { limit: 2, count: 'exact' })
    assert.equal(result.count, 2)
    assert.equal(result.total, 500)
  })

  it('sends the project and collection in the path', async () => {
    const calls = stub({ body: { rows: [], count: 0 } })
    await client().query('my users', {})
    assert.equal(
      calls[0].url,
      'https://gateway.example/v1/proj/my%20users/query',
    )
  })

  it('defaults filters and order to empty arrays', async () => {
    const calls = stub({ body: { rows: [], count: 0 } })
    await client().query('users', {})
    assert.deepEqual(bodyOf(calls[0]).filters, [])
    assert.deepEqual(bodyOf(calls[0]).order, [])
  })
})

describe('errors', () => {
  it('surfaces the gateway code, message and request id', async () => {
    stub({
      status: 422,
      body: {
        error: {
          code: 'validation_failed',
          message: "field 'id' expects a UUID, got 'nope'",
          request_id: 'abc123',
        },
      },
    })
    const err = await client()
      .query('users', {})
      .catch((e) => e as CradlerError)

    assert.ok(err instanceof CradlerError)
    assert.equal(err.status, 422)
    assert.equal(err.code, 'validation_failed')
    assert.equal(err.requestId, 'abc123')
  })

  it('still works against an error body with no request id', async () => {
    stub({
      status: 403,
      body: { error: { code: 'forbidden', message: 'nope' } },
    })
    const err = await client()
      .query('users', {})
      .catch((e) => e as CradlerError)
    assert.equal(err.code, 'forbidden')
    assert.equal(err.requestId, undefined)
  })

  it('does not crash on an error body it does not recognise', async () => {
    stub({ status: 500, body: { something: 'else' } })
    const err = await client()
      .query('users', {})
      .catch((e) => e as CradlerError)
    assert.equal(err.code, 'http_error')
    assert.equal(err.status, 500)
  })

  it('reports a transport failure as a network error, not a crash', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const err = await client()
      .query('users', {})
      .catch((e) => e as CradlerError)
    assert.equal(err.code, 'network_error')
    assert.equal(err.status, 0)
  })
})

describe('writes', () => {
  it('posts rows to the collection for insert', async () => {
    const calls = stub({ body: { rows: [], count: 0 } })
    await client().insert('users', [{ a: 1 }])
    assert.equal(calls[0].url, 'https://gateway.example/v1/proj/users')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), [{ a: 1 }])
  })

  it('sends the filters it was given on update', async () => {
    const calls = stub({ body: { rows: [], count: 0 } })
    await client().update('users', { name: 'x' }, [
      { field: 'id', op: 'eq', value: 1 },
    ])
    const body = bodyOf(calls[0])
    assert.deepEqual(body.patch, { name: 'x' })
    assert.equal((body.filters as unknown[]).length, 1)
  })
})
