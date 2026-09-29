/// <reference types="bun-types" />
import { describe, it, expect, beforeAll } from 'bun:test'
import { decodeStep } from '../steps/decode'
import { composeStep } from '../steps/compose'
import { preGuardrailStep } from '../steps/pre-guardrail'

// These tests hit live APIs. They are skipped automatically when env vars are absent.
// Run with:
//   ELEVENLABS_API_KEY=... TEST_AUDIO_URL=... bun test integration.test.ts
//
// For pre-guardrail bureau tests, also set:
//   BUREAU_SIDECAR_URL=http://localhost:8000 INTERNAL_API_SECRET=... TEST_MOBILE=9876543210

// Require a real ElevenLabs key (sk_...) — 'test-key' set by unit mock should not trigger live calls
const hasElevenLabs = process.env.ELEVENLABS_API_KEY?.startsWith('sk_') ?? false
const hasAudioUrl = !!process.env.TEST_AUDIO_URL
// Requires explicit BUREAU_LIVE=true so tests don't auto-run when .env has the
// config but the sidecar isn't actually started
const hasBureau = process.env.BUREAU_LIVE === 'true' &&
  !!(process.env.BUREAU_SIDECAR_URL && process.env.INTERNAL_API_SECRET && process.env.TEST_MOBILE)

const exec = (step: any, inputData: any, initData: any = {}) =>
  step.execute({
    inputData,
    mastra: null,
    getInitData: () => initData,
    getStepResult: () => undefined,
  })

// ── decode — ElevenLabs STT ───────────────────────────────────────────────────

describe('integration: decodeStep STT', () => {
  it.skipIf(!hasElevenLabs || !hasAudioUrl)(
    'transcribes real audio_url via ElevenLabs Scribe v2',
    async () => {
      const r = await exec(decodeStep, { audio_url: process.env.TEST_AUDIO_URL })
      expect(r.decoded_text).toBeTruthy()
      expect(r.decoded_text.length).toBeGreaterThan(0)
      expect(r.language).toMatch(/^[a-z]{2}$/)
      console.log(`[STT] language: ${r.language}, text: "${r.decoded_text.slice(0, 80)}"`)
    },
    30_000,
  )

  it.skipIf(!hasElevenLabs || !hasAudioUrl)(
    'returned language is a 2-letter code (not ISO 639-3)',
    async () => {
      const r = await exec(decodeStep, { audio_url: process.env.TEST_AUDIO_URL })
      // ElevenLabs returns 3-letter codes (eng, hin) — decode step must map them
      expect(r.language).not.toMatch(/^(eng|hin|guj|ben|tam)$/)
      expect(r.language.length).toBe(2)
    },
    30_000,
  )
})

// ── compose — ElevenLabs TTS ──────────────────────────────────────────────────

describe('integration: composeStep TTS', () => {
  it.skipIf(!hasElevenLabs)(
    'generates base64 audio data URI for tts channel',
    async () => {
      const r = await exec(composeStep, {
        response: 'Your CIBIL score is 750. Pay your dues on time to improve it.',
        channel: 'tts',
        session_id: 'integration-test',
      })
      expect(r.composed).toMatch(/^data:audio\/mpeg;base64,/)
      const b64 = r.composed.replace('data:audio/mpeg;base64,', '')
      expect(b64.length).toBeGreaterThan(1000) // real audio is substantial
      console.log(`[TTS] base64 length: ${b64.length} chars`)
    },
    30_000,
  )

  it.skipIf(!hasElevenLabs)(
    'strips markdown before sending to ElevenLabs — audio should decode cleanly',
    async () => {
      const r = await exec(composeStep, {
        response: '**Score:** 750\n_Tip:_ pay on time.\n- Reduce credit utilization\n- Avoid new enquiries',
        channel: 'tts',
        session_id: 'integration-test-md',
      })
      expect(r.composed).toMatch(/^data:audio\/mpeg;base64,/)
      const b64 = r.composed.replace('data:audio/mpeg;base64,', '')
      expect(b64.length).toBeGreaterThan(1000)
    },
    30_000,
  )

  it.skipIf(!hasElevenLabs)(
    'Hindi text TTS — produces non-empty audio',
    async () => {
      const r = await exec(composeStep, {
        response: 'आपका क्रेडिट स्कोर 750 है। समय पर भुगतान करें।',
        channel: 'tts',
        session_id: 'integration-test-hi',
      })
      expect(r.composed).toMatch(/^data:audio\/mpeg;base64,/)
    },
    30_000,
  )
})

// ── pre-guardrail — live bureau sidecar ──────────────────────────────────────

describe('integration: preGuardrailStep with bureau sidecar', () => {
  beforeAll(() => {
    if (hasBureau) {
      process.env.BUREAU_SIDECAR_URL = process.env.BUREAU_SIDECAR_URL!
      process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET!
    }
  })

  it.skipIf(!hasBureau)(
    'fetches real bureau profile and returns masked_profile',
    async () => {
      const mobile = process.env.TEST_MOBILE!
      const r = await exec(
        preGuardrailStep,
        { decoded_text: 'what is my CIBIL score?' },
        { mobile },
      )
      expect(r.pre_guardrail).toBe(true)
      expect(r.masked_profile).toBeDefined()
      console.log('[bureau] masked_profile keys:', Object.keys(r.masked_profile as object))
    },
    15_000,
  )

  it.skipIf(!hasBureau)(
    'masked_profile never contains raw mobile number',
    async () => {
      const mobile = process.env.TEST_MOBILE!
      const r = await exec(
        preGuardrailStep,
        { decoded_text: 'what is my CIBIL score?' },
        { mobile },
      )
      const profileStr = JSON.stringify(r.masked_profile ?? {})
      expect(profileStr).not.toContain(mobile)
    },
    15_000,
  )

  it.skipIf(!hasBureau)(
    'masked_profile never contains raw PAN or Aadhaar',
    async () => {
      const mobile = process.env.TEST_MOBILE!
      const r = await exec(
        preGuardrailStep,
        { decoded_text: 'show my bureau details' },
        { mobile },
      )
      const profileStr = JSON.stringify(r.masked_profile ?? {})
      // No raw PAN pattern
      expect(profileStr).not.toMatch(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/)
      // No raw 12-digit Aadhaar
      expect(profileStr).not.toMatch(/\b\d{4}\s?\d{4}\s?\d{4}\b/)
    },
    15_000,
  )

  it.skipIf(!hasBureau)(
    'guardrail still passes even if sidecar returns 404 (unknown user)',
    async () => {
      const r = await exec(
        preGuardrailStep,
        { decoded_text: 'what is my CIBIL score?' },
        { mobile: '0000000000' }, // non-existent user
      )
      expect(r.pre_guardrail).toBe(true)
      expect(r.masked_profile).toBeUndefined()
    },
    15_000,
  )
})
