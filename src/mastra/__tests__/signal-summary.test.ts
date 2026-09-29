/// <reference types="bun-types" />
import { describe, it, expect } from 'bun:test'
import { buildSignalSummary } from '../lib/signal-summary'

describe('buildSignalSummary', () => {
  it('renders segment, file depth, life stage, and the top compose bullets', () => {
    const s = buildSignalSummary({
      segment: 'prime',
      file_tier: 'thick',
      life_stage: 'established',
      compose: [
        { label: 'Home loan eligibility', verdict: 'eligible, none taken' },
        { label: 'Asset-backed borrowing', verdict: 'untapped' },
      ],
    })
    expect(s).toContain('prime score band')
    expect(s).toContain('long credit history')
    // The battery (2026-08-04) found the model echoes this summary verbatim: "thick file" reached 13 of
    // 45 replies because this string said it. Internal taxonomy must not appear here at all.
    expect(s).not.toContain('thick')
    expect(s).not.toContain('segment prime')
    expect(s).toContain('established life-stage')
    expect(s).toContain('- Home loan eligibility: eligible, none taken')
    expect(s).toContain('getSignals') // points the agent at the full set
  })

  it('caps the number of bullets', () => {
    const compose = Array.from({ length: 6 }, (_, i) => ({ label: `Sig ${i}`, verdict: 'x' }))
    const s = buildSignalSummary({ segment: 'prime', compose }, 2)
    expect(s).toContain('Sig 0')
    expect(s).toContain('Sig 1')
    expect(s).not.toContain('Sig 2')
  })

  it('returns empty string for missing/empty signals', () => {
    expect(buildSignalSummary(undefined)).toBe('')
    expect(buildSignalSummary({})).toBe('')
    expect(buildSignalSummary({ segment: 'no_score' })).toBe('') // nothing worth surfacing
  })

  it('does not spell exact age or income numbers', () => {
    const s = buildSignalSummary({
      segment: 'prime',
      tier1: { AGE_EXACT: 41, INCOME_FROM_CARD_LIMIT: 200000 },
      compose: [{ label: 'Wealth tier', verdict: 'Affluent' }],
    })
    expect(s).not.toContain('41')
    expect(s).not.toContain('200000')
  })
})
