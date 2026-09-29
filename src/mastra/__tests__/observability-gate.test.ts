/**
 * The Langfuse export gate. This is a PII boundary, not a feature flag: trace-level userId is a raw
 * mobile and prompts carry masked bureau data, so "exporter constructed" must imply "destination was
 * chosen deliberately". PR #19 review caught that keys alone were enough, which would have defaulted
 * the SDK to the public Langfuse Cloud host.
 */
import { describe, expect, test, afterEach } from 'bun:test'
import { buildObservability, identifierScrubProcessor } from '../lib/langfuse-observability'

const VARS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]))

function setEnv(values: Partial<Record<(typeof VARS)[number], string | undefined>>) {
  for (const v of VARS) {
    const next = values[v]
    if (next === undefined) delete process.env[v]
    else process.env[v] = next
  }
}

afterEach(() => setEnv(saved))

describe('buildObservability gate', () => {
  test('off with no config at all', () => {
    setEnv({})
    expect(buildObservability()).toBeUndefined()
  })

  test('off when keys are set but no base URL — never defaults to the public cloud', () => {
    setEnv({ LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test' })
    expect(buildObservability()).toBeUndefined()
  })

  test('off when the base URL is set but a key is missing', () => {
    setEnv({ LANGFUSE_SECRET_KEY: 'sk-lf-test', LANGFUSE_BASE_URL: 'https://langfuse.internal.example' })
    expect(buildObservability()).toBeUndefined()
  })

  test('on only with both keys and an explicit base URL', () => {
    setEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_BASE_URL: 'https://langfuse.internal.example',
    })
    expect(buildObservability()).toBeDefined()
  })
})

describe('identifierScrubProcessor', () => {
  const run = (span: Record<string, unknown>) => identifierScrubProcessor.process!(span as never) as any

  test('drops the bureau profile and signals payloads from span input, keeps the turn readable', () => {
    // The workflow root span's input is the whole workflow input, so it carries the unmasked sidecar
    // profile. No pattern can catch bulk financial data, so the keys go wholesale (PR #19 review).
    const out = run({
      input: {
        user_id: '9876543210',
        message: 'How is my credit profile',
        session_id: 's-1',
        channel: 'web',
        bureau_profile: { pii: { full_name: 'Rahul Sharma', email: 'rahul@example.com' }, loan_details: [{ emi: 45000 }] },
        signals: { tier1: { AGE_EXACT: 41, INCOME_FROM_CARD_LIMIT: 200000 } },
      },
    })
    const blob = JSON.stringify(out.input)
    expect(blob).not.toContain('Rahul Sharma')
    expect(blob).not.toContain('45000')
    expect(blob).not.toContain('AGE_EXACT')
    expect(blob).not.toContain('200000')
    // What observability needs survives; the mobile is still value-scrubbed as before.
    expect(out.input.message).toBe('How is my credit profile')
    expect(out.input.channel).toBe('web')
    expect(out.input.user_id).toBe('[REDACTED]')
  })

  test('drops the same payloads when they ride nested inside a step or memory span', () => {
    // Step spans and the OM/WorkingMemory processors carry the payload one or more levels down, which
    // a top-level-only pass missed (verified against a real trace: 134 hits inside OM spans alone).
    const out = run({
      input: { inputData: { masked_profile: { loan_details: [{ emi: 45000 }] } }, state: { signals: { AGE_EXACT: 41 } } },
      output: { nested: { bureau_profile: { dpd: [{ days: 90 }] } } },
    })
    const blob = JSON.stringify(out)
    expect(blob).not.toContain('loan_details')
    expect(blob).not.toContain('AGE_EXACT')
    expect(blob).not.toContain('dpd')
    expect(blob.match(/omitted: financial payload/g)).toHaveLength(3)
  })

  test('keeps the trace-level userId readable while scrubbing the rest of metadata', () => {
    const out = run({ metadata: { userId: '9876543210', note: 'ring 9876543210' } })
    expect(out.metadata.userId).toBe('9876543210') // deliberate carve-out, see server.ts
    expect(out.metadata.note).toBe('ring [REDACTED]')
  })
})
