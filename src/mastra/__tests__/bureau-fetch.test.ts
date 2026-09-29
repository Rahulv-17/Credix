/// <reference types="bun-types" />
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test'

/**
 * fetchBureau in-process cache: a user's bureau profile is fetched once and reused across turns
 * within the TTL, so a multi-turn conversation does not hit the sidecar every turn. Only `ok`
 * results are cached; not_found / error re-try next call.
 */

const originalFetch = global.fetch
afterAll(() => {
  global.fetch = originalFetch
})

let fetchBureau: (u: string) => Promise<any>
let clearBureauCache: () => void
let fetchCalls = 0

const okDoc = { user_id: '9111111111', general_info: { credit_score: 700 } }

beforeAll(async () => {
  // Set env BEFORE importing the module — CACHE_TTL_MS is read once at module load.
  process.env.BUREAU_CACHE_TTL_MS = '900000'
  process.env.BUREAU_SIDECAR_URL = 'http://localhost:8000'
  process.env.INTERNAL_API_SECRET = 'test-secret'
  ;({ fetchBureau, clearBureauCache } = await import('../lib/bureau-fetch'))

  global.fetch = (async (url: RequestInfo | URL) => {
    fetchCalls++
    const path = String(url)
    if (path.includes('/internal/bureau/9111111111')) {
      return { ok: true, status: 200, json: async () => ({ ...okDoc }) }
    }
    if (path.includes('/internal/bureau/0000000000')) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    return { ok: false, status: 500, json: async () => ({}) }
  }) as unknown as typeof fetch
})

beforeEach(() => {
  clearBureauCache()
  fetchCalls = 0
})

describe('fetchBureau cache', () => {
  it('fetches once and reuses the profile on the second call (same user_id)', async () => {
    const a = await fetchBureau('9111111111')
    const b = await fetchBureau('9111111111')
    expect(a).toEqual({ ok: true, profile: { ...okDoc } })
    expect(b).toEqual({ ok: true, profile: { ...okDoc } })
    expect(fetchCalls).toBe(1) // second call served from cache
  })

  it('re-fetches after clearBureauCache()', async () => {
    await fetchBureau('9111111111')
    expect(fetchCalls).toBe(1)
    clearBureauCache()
    await fetchBureau('9111111111')
    expect(fetchCalls).toBe(2)
  })

  it('does not cache not_found (404) — retries next call', async () => {
    const a = await fetchBureau('0000000000')
    const b = await fetchBureau('0000000000')
    expect(a).toEqual({ ok: false, notFound: true })
    expect(b).toEqual({ ok: false, notFound: true })
    expect(fetchCalls).toBe(2)
  })

  it('does not cache errors (5xx) — retries next call', async () => {
    const a = await fetchBureau('9999999999')
    const b = await fetchBureau('9999999999')
    expect(a).toEqual({ ok: false, status: 500 })
    expect(b).toEqual({ ok: false, status: 500 })
    expect(fetchCalls).toBe(2)
  })
})
