/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { verdictForExport } from '../lib/langfuse-eval'

/**
 * The eval reporter states a "verdict only" rule, and the agent pass broke it by exporting a scrubbed model
 * reply on the reasoning that scrubbing made it safe (PR #20 review). It does not: scrubIdentifiers matches
 * identifier PATTERNS, so a reply naming a utilisation and a balance carries nothing for it to match. The
 * guard now enforces the rule at the export boundary, since a comment asking callers to be careful is what
 * failed the first time. These assertions are what fail if someone removes it.
 */
describe('verdictForExport', () => {
  test('drops the model reply, keeps the verdict', () => {
    const out = verdictForExport(
      { passed: false, reason: 'none of [59000] in the reply', matched: null, reply: 'Your utilisation is 38% and you owe ₹2,40,000.' },
      'a-fees-reserve',
    ) as Record<string, unknown>
    expect(out.reply).toBeUndefined()
    expect(out.passed).toBe(false)
    expect(out.reason).toBe('none of [59000] in the reply')
    expect(JSON.stringify(out)).not.toContain('2,40,000')
    expect(JSON.stringify(out)).not.toContain('38%')
  })

  test('every model-text alias is dropped, not just "reply"', () => {
    // A future caller will reach for one of these names; the guard has to cover the class, not one word.
    for (const key of ['reply', 'response', 'text', 'message', 'content', 'output', 'completion', 'answer', 'transcript', 'prose']) {
      const out = verdictForExport({ passed: true, [key]: 'sensitive prose about this customer' }, 'c') as Record<string, unknown>
      expect(out[key]).toBeUndefined()
      expect(out.passed).toBe(true)
    }
  })

  test('matching is case-insensitive, so Reply and REPLY do not slip through', () => {
    const out = verdictForExport({ Reply: 'prose', REPLY: 'prose', ok: 1 }, 'c') as Record<string, unknown>
    expect(out.Reply).toBeUndefined()
    expect(out.REPLY).toBeUndefined()
    expect(out.ok).toBe(1)
  })

  test('the safe verdict shape tool-battery sends passes through untouched', () => {
    // Field names and our own assertion text are the whole point of the payload; the guard must not eat them.
    const shape = { found: 'true', joining_fee: '12000', first_year_note: 'string(140)' }
    const out = verdictForExport({ verdict: 'fail', reason: 'year one quoted as 14160', shape }, 'fees-fyf-1') as Record<string, unknown>
    expect(out.verdict).toBe('fail')
    expect(out.reason).toBe('year one quoted as 14160')
    expect(out.shape).toEqual(shape)
  })

  test('non-object verdicts pass through rather than being mangled', () => {
    expect(verdictForExport(null, 'c')).toBeNull()
    expect(verdictForExport('plain', 'c')).toBe('plain')
    expect(verdictForExport([1, 2], 'c')).toEqual([1, 2])
  })
})
