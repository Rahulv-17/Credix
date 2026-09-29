/// <reference types="bun-types" />
import { describe, it, expect } from 'bun:test'
import {
  AppError,
  BureauSidecarError,
  LLMApiError,
  STTError,
  TTSError,
  ValidationError,
} from '../lib/errors'

describe('AppError', () => {
  it('sets name, statusCode, code, isOperational', () => {
    const e = new AppError('something broke', 503, 'SERVICE_DOWN')
    expect(e.name).toBe('AppError')
    expect(e.statusCode).toBe(503)
    expect(e.code).toBe('SERVICE_DOWN')
    expect(e.isOperational).toBe(true)
    expect(e.message).toBe('something broke')
  })

  it('is instance of Error', () => {
    expect(new AppError('x', 500, 'X')).toBeInstanceOf(Error)
  })

  it('toHttpResponse includes message and code', () => {
    const r = new AppError('test error', 400, 'TEST').toHttpResponse()
    expect(r.success).toBe(false)
    expect(r.error.message).toBe('test error')
    expect(r.error.code).toBe('TEST')
  })
})

describe('BureauSidecarError', () => {
  it('404 → HTTP 404, BUREAU_NOT_FOUND, "not found" message', () => {
    // Context is always a non-PII descriptor in real code (e.g. a bureau section name) —
    // never a user_id/mobile, matching the codebase's no-PII-in-errors rule.
    const e = new BureauSidecarError(404, 'test-context')
    expect(e.statusCode).toBe(404)
    expect(e.code).toBe('BUREAU_NOT_FOUND')
    expect(e.sidecarStatus).toBe(404)
    expect(e.message).toContain('Bureau record not found')
    expect(e.message).toContain('test-context')
  })

  it('500 → HTTP 502, BUREAU_SIDECAR_ERROR, "unavailable" message', () => {
    const e = new BureauSidecarError(500, 'section loan_details')
    expect(e.statusCode).toBe(502)
    expect(e.code).toBe('BUREAU_SIDECAR_ERROR')
    expect(e.message).toContain('Bureau sidecar unavailable (HTTP 500)')
  })

  it('503 → HTTP 502 Bad Gateway', () => {
    expect(new BureauSidecarError(503).statusCode).toBe(502)
  })

  it('works without context argument', () => {
    const e = new BureauSidecarError(404)
    expect(e.message).toBe('Bureau record not found')
  })

  it('is instance of AppError and Error', () => {
    const e = new BureauSidecarError(404)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
  })
})

describe('LLMApiError', () => {
  it('carries llmStatus and HTTP 502', () => {
    const e = new LLMApiError(503)
    expect(e.llmStatus).toBe(503)
    expect(e.statusCode).toBe(502)
    expect(e.code).toBe('LLM_API_ERROR')
    expect(e.message).toBe('LLM API returned 503')
  })
})

describe('STTError', () => {
  it('prefixes message with "STT failed:"', () => {
    const e = new STTError('connection reset')
    expect(e.message).toBe('STT failed: connection reset')
    expect(e.statusCode).toBe(502)
    expect(e.code).toBe('STT_ERROR')
  })

  it('message contains original detail for retry test compatibility', () => {
    const e = new STTError('[STT] non-retriable (HTTP 402): paid')
    expect(e.message).toContain('non-retriable (HTTP 402)')
  })
})

describe('TTSError', () => {
  it('prefixes message with "TTS failed:"', () => {
    const e = new TTSError('empty audio stream')
    expect(e.message).toBe('TTS failed: empty audio stream')
    expect(e.statusCode).toBe(502)
    expect(e.code).toBe('TTS_ERROR')
  })
})

describe('ValidationError', () => {
  it('HTTP 400, VALIDATION_ERROR, carries details', () => {
    const e = new ValidationError('Bad input', [{ field: 'mobile', message: 'Required' }])
    expect(e.statusCode).toBe(400)
    expect(e.code).toBe('VALIDATION_ERROR')
    expect(e.details).toHaveLength(1)
    expect(e.details[0].field).toBe('mobile')
  })

  it('toHttpResponse includes details array', () => {
    const r = new ValidationError('err', [{ field: 'f', message: 'm' }]).toHttpResponse()
    expect(r.error).toHaveProperty('details')
  })
})
