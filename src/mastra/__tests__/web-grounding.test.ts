/// <reference types="bun-types" />
import { describe, it, expect, mock } from 'bun:test'
import { shouldGroundWithWeb, groundWithWeb } from '../lib/web-grounding'
import { exaMockState, exaMockFactory } from './exa-mock'

// Mock the exa-js dependency (NOT tools/exa), so webSearch/exaSearch/EXA_CATEGORIES stay intact and
// this matches the one shared stub every grounding test registers (see exa-mock.ts / lessons.md).
mock.module('exa-js', exaMockFactory)

// The skip heuristic is pure (no network) — it decides which turns are worth a web search.
// It is message-only: the bureau_query skip lives in understand.ts (intent is classified
// concurrently, so the step discards the context for that intent after the fact).
describe('shouldGroundWithWeb', () => {
  it('skips greetings (incl. the AutoOpener "Hi")', () => {
    for (const g of ['Hi', 'hi', 'hello', 'Hey', 'heyyy', 'Good morning', 'namaste', 'yo']) {
      expect(shouldGroundWithWeb(g)).toBe(false)
    }
  })

  it('skips trivially short turns', () => {
    expect(shouldGroundWithWeb('ok')).toBe(false)
    expect(shouldGroundWithWeb('thanks')).toBe(false)
  })

  it('grounds substantive questions', () => {
    expect(shouldGroundWithWeb('best cashback credit card in India right now')).toBe(true)
    expect(shouldGroundWithWeb('how do I raise my score fast')).toBe(true)
    expect(shouldGroundWithWeb('what are current home loan interest rates')).toBe(true)
  })
})

describe('groundWithWeb', () => {
  it('returns no context (fail-soft) when a search is skipped', async () => {
    const ctx = await groundWithWeb('Hi')
    expect(ctx).toBe('')
  })

  it('returns no context (fail-soft) when EXA_API_KEY is missing', async () => {
    const prev = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    try {
      const ctx = await groundWithWeb('best cashback card in India')
      expect(ctx).toBe('')
    } finally {
      if (prev !== undefined) process.env.EXA_API_KEY = prev
    }
  })

  // Security: the raw user message is sent to Exa (a third party), so hard identifiers must be
  // redacted from the query first. exaMockState.lastQuery captures exactly what reached search().
  it('scrubs PAN / Aadhaar / mobile from the query before it reaches Exa', async () => {
    const prev = process.env.EXA_API_KEY
    process.env.EXA_API_KEY = 'test-exa-key'
    exaMockState.reset()
    try {
      await groundWithWeb('link aadhaar 4444 5555 6666 and pan ABCDE1234F and mobile 9876543210 to my loan')
      // Guard the mock itself: if the exa-js stub were ever bypassed (real client, network), calls
      // stays 0 and this fails loudly instead of the scrub assertions passing on an empty lastQuery.
      expect(exaMockState.calls).toBeGreaterThan(0)
      expect(exaMockState.lastQuery).toContain('[REDACTED]')
      expect(exaMockState.lastQuery).not.toContain('4444 5555 6666')
      expect(exaMockState.lastQuery).not.toContain('ABCDE1234F')
      expect(exaMockState.lastQuery).not.toContain('9876543210')
    } finally {
      if (prev === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = prev
    }
  })
})
