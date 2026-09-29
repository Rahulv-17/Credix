/// <reference types="bun-types" />
import { describe, it, expect, mock } from 'bun:test'
import { agentMockFactory } from './agent-mock'

// server.ts imports the registered mastra (real agents built at load); stub the Agent class first,
// then dynamic-import so the app graph builds without a network call (same pattern as e2e.test.ts).
mock.module('@mastra/core/agent', agentMockFactory)
const { statementSchema } = await import('../server')

// Build a statement payload with `n` chunks each carrying `chunkText` characters, and a declared
// meta.chars. Lets each test dial the aggregate independently of the per-field maxima.
function makeDoc(opts: { n: number; chunkText: number; metaChars: number }) {
  const text = 'x'.repeat(opts.chunkText)
  return {
    mobile: '9876543210',
    document: {
      meta: { source: 'test.pdf', pages: 1, chars: opts.metaChars, uploadedAt: '2026-07-13T00:00:00Z' },
      chunks: Array.from({ length: opts.n }, (_, i) => ({
        id: `c${i}`,
        index: i,
        heading: 'H',
        text,
        chars: opts.chunkText,
      })),
    },
  }
}

describe('statementSchema aggregate-size enforcement (Sudhanshu P1, PR #14)', () => {
  it('accepts a normal statement whose chunk text is within meta.chars and the cap', () => {
    const doc = makeDoc({ n: 5, chunkText: 1_000, metaChars: 10_000 }) // 5,000 total <= 10,000 declared
    expect(statementSchema.safeParse(doc).success).toBe(true)
  })

  it('rejects the abuse case that passes per-field maxima: 2,000 chunks x 100,000 chars (~200 MB)', () => {
    // Every field is individually legal (<=100,000 chars, <=2,000 chunks) but the aggregate is ~200 MB.
    const doc = makeDoc({ n: 2_000, chunkText: 100_000, metaChars: 5_000_000 })
    const res = statementSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) expect(JSON.stringify(res.error.issues)).toContain('exceeds the 5000000 character cap')
  })

  it('rejects when declared meta.chars understates the real chunk text (smuggling guard)', () => {
    // 20 chunks x 50,000 = 1,000,000 real chars, but meta claims only 1,000.
    const doc = makeDoc({ n: 20, chunkText: 50_000, metaChars: 1_000 })
    const res = statementSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) expect(JSON.stringify(res.error.issues)).toContain('less than the actual chunk text')
  })

  it('accepts meta.chars >= actual (headings/whitespace not counted in the sum)', () => {
    const doc = makeDoc({ n: 10, chunkText: 2_000, metaChars: 25_000 }) // 20,000 actual <= 25,000 declared
    expect(statementSchema.safeParse(doc).success).toBe(true)
  })
})
