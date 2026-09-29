/// <reference types="bun-types" />
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test'

/**
 * fetchUserStory in-process cache: the precomputed signal payload is fetched once and reused across
 * turns within the TTL. Only `ok` results are cached; not_found / error re-try next call. Mirrors
 * bureau-fetch.test.ts.
 */

const originalFetch = global.fetch
afterAll(() => {
  global.fetch = originalFetch
})

let fetchUserStory: (u: string) => Promise<any>
let clearUserStoryCache: () => void
let peekUserStory: (u: string) => any
let fetchCalls = 0

const okSignals = {
  segment: 'prime',
  tier1: { AGE_EXACT: 41 },
  tier2: { AFFLUENCE_TIER: 'Mass-Affluent' },
  compose: [{ var: 'SECURED_CROSS_SELL_FLAG', label: 'Asset-backed borrowing' }],
  _meta: { compute_ms: 1.23 },
}

beforeAll(async () => {
  // Set env BEFORE importing the module — CACHE_TTL_MS is read once at module load.
  process.env.USER_STORY_CACHE_TTL_MS = '900000'
  process.env.BUREAU_SIDECAR_URL = 'http://localhost:8000'
  process.env.INTERNAL_API_SECRET = 'test-secret'
  ;({ fetchUserStory, clearUserStoryCache, peekUserStory } = await import('../lib/user-story-fetch'))

  global.fetch = (async (url: RequestInfo | URL) => {
    fetchCalls++
    const path = String(url)
    if (path.includes('/internal/user-story/9111111111')) {
      return { ok: true, status: 200, json: async () => ({ signals: { ...okSignals } }) }
    }
    if (path.includes('/internal/user-story/0000000000')) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    return { ok: false, status: 500, json: async () => ({}) }
  }) as unknown as typeof fetch
})

beforeEach(() => {
  clearUserStoryCache()
  fetchCalls = 0
})

describe('fetchUserStory cache', () => {
  it('fetches once and reuses the signals on the second call (same user_id)', async () => {
    const a = await fetchUserStory('9111111111')
    const b = await fetchUserStory('9111111111')
    expect(a).toEqual({ ok: true, signals: { ...okSignals } })
    expect(b).toEqual({ ok: true, signals: { ...okSignals } })
    expect(fetchCalls).toBe(1) // second call served from cache
  })

  it('peekUserStory returns the cached payload without a fetch', async () => {
    await fetchUserStory('9111111111')
    expect(fetchCalls).toBe(1)
    expect(peekUserStory('9111111111')).toEqual({ ...okSignals })
    expect(fetchCalls).toBe(1) // peek does not fetch
    expect(peekUserStory('9999999999')).toBeUndefined()
  })

  it('re-fetches after clearUserStoryCache()', async () => {
    await fetchUserStory('9111111111')
    clearUserStoryCache()
    await fetchUserStory('9111111111')
    expect(fetchCalls).toBe(2)
  })

  it('does not cache not_found (404) — retries next call', async () => {
    const a = await fetchUserStory('0000000000')
    const b = await fetchUserStory('0000000000')
    expect(a).toEqual({ ok: false, notFound: true })
    expect(b).toEqual({ ok: false, notFound: true })
    expect(fetchCalls).toBe(2)
  })

  it('does not cache errors (5xx) — retries next call', async () => {
    const a = await fetchUserStory('8888888888')
    const b = await fetchUserStory('8888888888')
    expect(a).toEqual({ ok: false, status: 500 })
    expect(b).toEqual({ ok: false, status: 500 })
    expect(fetchCalls).toBe(2)
  })
})
