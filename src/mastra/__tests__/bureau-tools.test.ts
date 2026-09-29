/// <reference types="bun-types" />
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'

const originalFetch = global.fetch
afterAll(() => { global.fetch = originalFetch })

import { getBureauProfile, getBureauDetail } from '../tools/bureau'

const execTool = (tool: any, inputData: any) => tool.execute(inputData)

const fakeBureauDoc = {
  user_id: '9876543210',
  general_info: { credit_score: 720, full_name: 'Test User' },
  loan_details: { active_loans: 2 },
  pii: { mobile: '9876543210', pan: 'ABCDE1234F', aadhaar: '444455556666' },
}

beforeAll(() => {
  process.env.BUREAU_SIDECAR_URL = 'http://localhost:8000'
  process.env.INTERNAL_API_SECRET = 'test-secret'

  global.fetch = (async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path.includes('/internal/bureau/9876543210/loan_details')) {
      return { ok: true, json: async () => ({ loan_details: fakeBureauDoc.loan_details, pii: fakeBureauDoc.pii }) }
    }
    if (path.includes('/internal/bureau/9876543210')) {
      return { ok: true, json: async () => ({ ...fakeBureauDoc }) }
    }
    if (path.includes('/internal/bureau/0000000000')) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    return { ok: false, status: 500, json: async () => ({}) }
  }) as unknown as typeof fetch
})

describe('getBureauProfile', () => {
  it('returns profile with pii key stripped', async () => {
    const r = await execTool(getBureauProfile, { user_id: '9876543210' })
    expect(r).not.toHaveProperty('pii')
    expect(r.general_info).toBeDefined()
    expect(r.user_id).toBe('9876543210')
  })

  it('pii is never present even if sidecar sends it', async () => {
    const r = await execTool(getBureauProfile, { user_id: '9876543210' })
    expect((r as any).pii).toBeUndefined()
  })

  it('throws BureauSidecarError on 404', async () => {
    await expect(execTool(getBureauProfile, { user_id: '0000000000' }))
      .rejects.toThrow('Bureau record not found')
  })
})

describe('getBureauDetail', () => {
  it('returns section data with pii stripped', async () => {
    const r = await execTool(getBureauDetail, { user_id: '9876543210', section: 'loan_details' })
    expect(r).not.toHaveProperty('pii')
    expect(r.loan_details).toBeDefined()
  })

  it('throws BureauSidecarError on sidecar error for a section fetch', async () => {
    await expect(execTool(getBureauDetail, { user_id: '0000000000', section: 'loan_details' }))
      .rejects.toThrow('Bureau record not found')
  })
})
