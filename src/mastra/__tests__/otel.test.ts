import { describe, expect, test } from 'bun:test'
import { recordError, safeStringify } from '../lib/otel'

describe('safeStringify (stage I/O capture sanitizer)', () => {
  test('redacts mobile, PAN, and Aadhaar from captured payloads', () => {
    const out = safeStringify({
      decoded_text: 'call me on 9876543210, pan ABCDE1234F, aadhaar 4444 5555 6666',
    })
    expect(out).not.toContain('9876543210')
    expect(out).not.toContain('ABCDE1234F')
    expect(out).not.toContain('4444 5555 6666')
    expect(out).toContain('[REDACTED]')
    // the surrounding coaching text stays visible
    expect(out).toContain('call me on')
  })

  test('redacts email addresses, including one whose local part is a mobile', () => {
    // Pattern order matters: scrubbing digits first would leave "[REDACTED]@mail.com" behind, which
    // still names the domain and reads as a scrubbed field rather than an unhandled one (PR #19 review).
    const out = safeStringify({ pii: { email: 'rahul.sharma@example.com', alt: '9876543210@upi.example' } })
    expect(out).not.toContain('rahul.sharma')
    expect(out).not.toContain('example.com')
    expect(out).not.toContain('upi.example')
    expect(out).toContain('[REDACTED]')
  })

  test('compresses base64 data URIs (tts audio blob) to a byte marker', () => {
    const blob = 'A'.repeat(5000)
    const out = safeStringify({ composed: `data:audio/mpeg;base64,${blob}` })
    expect(out).not.toContain(blob)
    expect(out).toContain('data:audio/mpeg;base64,<')
    expect(out).toContain('b64 chars>')
  })

  test('truncates oversized payloads with a marker', () => {
    const out = safeStringify({ big: 'x'.repeat(20000) }, 1000)
    expect(out.length).toBeLessThan(1100)
    expect(out).toContain('…[+')
  })

  test('handles strings, objects, and non-serializable input without throwing', () => {
    expect(safeStringify('plain text')).toBe('plain text')
    expect(safeStringify({ a: 1 })).toBe('{"a":1}')
    const circular: any = {}
    circular.self = circular
    expect(typeof safeStringify(circular)).toBe('string') // falls back to String()
  })
})

describe('recordError (exception sanitizer)', () => {
  test('scrubs identifiers from exception message and stack before recording', () => {
    let recorded: { message?: string; stack?: string } | undefined
    const span = {
      setAttribute() {},
      recordException(e: any) {
        recorded = e
      },
      setStatus() {},
    } as any
    recordError(span, new Error('parse failed for 9876543210 pan ABCDE1234F'), 'err-test')
    expect(recorded?.message).not.toContain('9876543210')
    expect(recorded?.message).not.toContain('ABCDE1234F')
    expect(recorded?.message).toContain('[REDACTED]')
    // the stack's first line repeats the message, so it must be scrubbed too
    expect(recorded?.stack ?? '').not.toContain('9876543210')
  })
})
