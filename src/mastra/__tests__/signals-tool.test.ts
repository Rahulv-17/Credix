/// <reference types="bun-types" />
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test'

/**
 * getSignals tool: hands an agent the precomputed signal payload from the in-process cache
 * (lib/user-story-fetch), falling back to a fetch on a miss. Section-narrowing returns just that
 * slice; an unknown user returns { available: false }.
 */

const originalFetch = global.fetch
afterAll(() => {
  global.fetch = originalFetch
})

let getSignals: any
let clearUserStoryCache: () => void
let fetchCalls = 0

const okSignals = {
  segment: 'prime',
  file_tier: 'thick',
  tier1: { AGE_EXACT: 41, INCOME_FROM_CARD_LIMIT: 200000 },
  tier2: { AFFLUENCE_TIER: 'Affluent', HOME_LOAN_WHITESPACE: 1 },
  compose: [{ var: 'HOME_LOAN_WHITESPACE', label: 'Home loan eligibility', verdict: 'eligible' }],
  _meta: { compute_ms: 0.9 },
}

const execTool = (tool: any, inputData: any) => tool.execute(inputData)

beforeAll(async () => {
  process.env.USER_STORY_CACHE_TTL_MS = '900000'
  process.env.BUREAU_SIDECAR_URL = 'http://localhost:8000'
  process.env.INTERNAL_API_SECRET = 'test-secret'
  ;({ clearUserStoryCache } = await import('../lib/user-story-fetch'))
  ;({ getSignals } = await import('../tools/signals'))

  global.fetch = (async (url: RequestInfo | URL) => {
    fetchCalls++
    const path = String(url)
    if (path.includes('/internal/user-story/9111111111')) {
      return { ok: true, status: 200, json: async () => ({ signals: { ...okSignals } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
})

beforeEach(() => {
  clearUserStoryCache()
  fetchCalls = 0
})

describe('getSignals tool', () => {
  it('returns the full payload from a cache miss (fetches once)', async () => {
    const out = await execTool(getSignals, { user_id: '9111111111' })
    expect(out.available).toBe(true)
    expect(out.tier1.AGE_EXACT).toBe(41) // exact age reaches the agent
    expect(out.tier2.AFFLUENCE_TIER).toBe('Affluent')
    expect(Array.isArray(out.compose)).toBe(true)
    expect(fetchCalls).toBe(1)
  })

  it('reads the in-process cache on the second call (no extra fetch)', async () => {
    await execTool(getSignals, { user_id: '9111111111' })
    const out = await execTool(getSignals, { user_id: '9111111111' })
    expect(out.available).toBe(true)
    expect(fetchCalls).toBe(1) // second call served from cache via peekUserStory
  })

  it('narrows to a section when asked', async () => {
    const out = await execTool(getSignals, { user_id: '9111111111', section: 'compose' })
    expect(out.available).toBe(true)
    expect(out.section).toBe('compose')
    expect(out.compose[0].label).toBe('Home loan eligibility')
    expect(out.tier1).toBeUndefined() // only the requested slice
  })

  it('reports unavailable for an unknown user', async () => {
    const out = await execTool(getSignals, { user_id: '0000000000' })
    expect(out).toEqual({ available: false, message: 'No computed signals for this user.' })
  })

  it('prefers user_id from requestContext over the input arg', async () => {
    // Arg points at an unknown user; the central context points at the known one. Context must win,
    // so the tool resolves the known user's signals rather than reporting unavailable.
    const context = { requestContext: { get: (k: string) => (k === 'user_id' ? '9111111111' : undefined) } }
    const out = await getSignals.execute({ user_id: '0000000000' }, context)
    expect(out.available).toBe(true)
    expect(out.tier1.AGE_EXACT).toBe(41)
  })

  it('resolves from requestContext when the agent omits user_id entirely', async () => {
    // The case the context-first change actually aims at (PR #19 review): a worker that trusts the
    // context and sends no user_id. While the schema required it, validation rejected the call before
    // execute ran, so the lookup never happened. The arg is optional now.
    expect(getSignals.inputSchema.safeParse({ section: 'compose' }).success).toBe(true)
    const context = { requestContext: { get: (k: string) => (k === 'user_id' ? '9111111111' : undefined) } }
    const out = await getSignals.execute({}, context)
    expect(out.available).toBe(true)
    expect(out.tier1.AGE_EXACT).toBe(41)
  })

  it('throws when neither the context nor an arg supplies a user_id', async () => {
    // Optional must not mean "fetch for whoever the fallback names": with no id at all this is a bug,
    // not an empty result.
    expect(getSignals.execute({})).rejects.toThrow(/user_id unavailable/)
  })
})
