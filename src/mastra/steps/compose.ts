import { createStep } from '@mastra/core/workflows'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
import { z } from 'zod'
import { STEP_IDS } from '../lib/patterns'
import { withRetry } from '../lib/retry'
import { AppError, TTSError } from '../lib/errors'
import { instrumentStage } from '../lib/otel'

const Channel = z.enum(['whatsapp', 'web', 'tts'])
type Channel = z.infer<typeof Channel>

function toWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/^#{1,6}\s/gm, '')
    .replace(/^- /gm, '• ')
    .split('\n\n')
    .map(para => para.split('\n').slice(0, 3).join('\n'))
    .join('\n\n')
    .trim()
}

function toTtsText(text: string): string {
  return text
    .replace(/[*_`#>]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\n+/g, ' ')
    .trim()
}

async function toTtsAudio(text: string): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new TTSError('ELEVENLABS_API_KEY is required for TTS')
  // Construct the client ONCE per call, not per retry attempt (review #6).
  const client = new ElevenLabsClient({ apiKey })
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'
  try {
    return await withRetry(async () => {
      const audioStream = await client.textToSpeech.convert(voiceId, {
        text,
        modelId: 'eleven_flash_v2_5',
        applyTextNormalization: 'on',
      })
      const chunks: Buffer[] = []
      for await (const chunk of audioStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const buf = Buffer.concat(chunks)
      if (buf.byteLength === 0) {
        // Treat empty stream as a retriable server error
        throw new TTSError('empty audio stream from ElevenLabs')
      }
      return `data:audio/mpeg;base64,${buf.toString('base64')}`
    }, 'TTS')
  } catch (err: any) {
    throw err instanceof AppError ? err : new TTSError(err instanceof Error ? err.message : String(err))
  }
}

export const composeStep = createStep({
  id: STEP_IDS.COMPOSE,
  description: 'Format response for delivery channel — WhatsApp (markdown stripped), web (passthrough), tts (ElevenLabs audio)',
  inputSchema: z.object({
    response: z.string(),
    channel: Channel.default('web'),
    active_skill: z.string().optional(),
    session_id: z.string(),
    // Upstream degradation markers, carried through unchanged so they reach workflowOutput.
    degraded: z.boolean().default(false),
    error_code: z.string().optional(),
  }),
  outputSchema: z.object({
    composed: z.string(),
    channel: Channel,
    active_skill: z.string(),
    session_id: z.string(),
    // True when the TTS channel fell back to text because audio synthesis failed — the answer
    // is preserved (composed holds the spoken text), not lost to a 502.
    tts_failed: z.boolean().default(false),
    // Passed through from upstream: a real backend degradation behind a safe 200 fallback.
    degraded: z.boolean().default(false),
    error_code: z.string().optional(),
  }),
  execute: async ({ inputData }) =>
    instrumentStage(STEP_IDS.COMPOSE, inputData, async () => {
    const { response, channel, session_id } = inputData
    const active_skill = inputData.active_skill ?? 'general'
    const degraded = inputData.degraded ?? false
    const error_code = inputData.error_code

    let composed: string
    let tts_failed = false
    switch (channel) {
      case 'whatsapp':
        composed = toWhatsApp(response)
        break
      case 'tts': {
        const ttsText = toTtsText(response)
        try {
          composed = await toTtsAudio(ttsText)
        } catch (err) {
          // Fail soft: TTS is the last step. A synthesis outage must not discard an
          // already-composed, PII-scrubbed answer as a 502. Return the spoken text and flag it
          // so the caller can render text or do client-side TTS. The error is still logged.
          // Log only the error name/status, never err.message: provider errors can carry
          // request detail. PII is already scrubbed upstream; this is defence-in-depth.
          const tag = err instanceof Error ? err.name : typeof err
          const status = (err as { status?: unknown })?.status
          console.warn(`[compose] TTS failed, falling back to text: ${tag}${status ? ` (${status})` : ''}`)
          composed = ttsText
          tts_failed = true
        }
        break
      }
      default:
        composed = response
    }

    return { composed, channel, active_skill, session_id, tts_failed, degraded, error_code }
    }),
})
