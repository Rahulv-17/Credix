/// <reference types="bun-types" />
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'

const originalFetch = global.fetch
afterAll(() => { global.fetch = originalFetch })

import { identityCheckStep, normalizeUserId } from '../steps/identity-check'

const exec = (inputData: any) =>
  (identityCheckStep as any).execute({
    inputData,
    mastra: null,
    getInitData: () => ({}),
    getStepResult: () => undefined,
  })

beforeAll(() => {
  process.env.BUREAU_SIDECAR_URL = 'http://localhost:8000'
  process.env.INTERNAL_API_SECRET = 'test-secret'

  global.fetch = (async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path.includes('/internal/bureau/9876543210')) {
      return { ok: true, status: 200, json: async () => ({ user_id: '9876543210' }) }
    }
    if (path.includes('/internal/bureau/8888888888')) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    return { ok: false, status: 500, json: async () => ({}) }
  }) as unknown as typeof fetch
})

describe('normalizeUserId', () => {
  it('accepts bare 10-digit mobile', () => {
    expect(normalizeUserId('9876543210')).toBe('9876543210')
  })

  it('strips +91 country code', () => {
    expect(normalizeUserId('+919876543210')).toBe('9876543210')
  })

  it('strips spaces', () => {
    expect(normalizeUserId('98765 43210')).toBe('9876543210')
  })

  it('returns null for 9-digit number', () => {
    expect(normalizeUserId('987654321')).toBeNull()
  })

  it('returns null for non-numeric string', () => {
    expect(normalizeUserId('not-a-number')).toBeNull()
  })
})

describe('identityCheckStep', () => {
  it('verifies a known user', async () => {
    const r = await exec({ mobile: '9876543210' })
    expect(r.identity_verified).toBe(true)
    expect(r.user_id).toBe('9876543210')
    expect(r.error).toBeUndefined()
  })

  it('returns invalid_mobile for bad format', async () => {
    const r = await exec({ mobile: 'abc' })
    expect(r.identity_verified).toBe(false)
    expect(r.error).toBe('invalid_mobile')
    expect(r.user_id).toBeUndefined()
  })

  it('returns no_bureau_record for 404', async () => {
    const r = await exec({ mobile: '8888888888' })
    expect(r.identity_verified).toBe(false)
    expect(r.error).toBe('no_bureau_record')
    expect(r.user_id).toBe('8888888888')
  })

  it('never throws when sidecar is unreachable', async () => {
    const savedFetch = global.fetch
    global.fetch = (async () => { throw new Error('connection refused') }) as unknown as typeof fetch
    const r = await exec({ mobile: '9876543210' })
    expect(r.identity_verified).toBe(false)
    expect(r.error).toBe('sidecar_unreachable')
    global.fetch = savedFetch
  })
})
