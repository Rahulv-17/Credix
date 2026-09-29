import { createStep } from '@mastra/core/workflows'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
import { readFileSync } from 'fs'
import { z } from 'zod'
import { STEP_IDS } from '../lib/patterns'
import { withRetry } from '../lib/retry'
import { STTError } from '../lib/errors'
import { instrumentStage } from '../lib/otel'

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', flac: 'audio/flac', webm: 'audio/webm',
  aac: 'audio/aac', opus: 'audio/ogg',
}

const LANG_RANGES: Array<[number, number, string]> = [
  [0x0900, 0x097F, 'hi'], // Devanagari → Hindi
  [0x0A80, 0x0AFF, 'gu'], // Gujarati
  [0x0980, 0x09FF, 'bn'], // Bengali
  [0x0B80, 0x0BFF, 'ta'], // Tamil
]

function detectLanguage(text: string): string {
  const counts: Record<string, number> = {}
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    for (const [lo, hi, lang] of LANG_RANGES) {
      if (cp >= lo && cp <= hi) {
        counts[lang] = (counts[lang] ?? 0) + 1
        break
      }
    }
  }
  const dominant = Object.entries(counts).sort(([, a], [, b]) => b - a)[0]
  return dominant ? dominant[0] : 'en'
}

export const decodeStep = createStep({
  id: STEP_IDS.DECODE,
  description: 'NFC normalization, script-based language detection, and ElevenLabs STT for audio input',
  inputSchema: z.object({
    message: z.string().optional(),
    audio_url: z.string().optional(),
  }),
  outputSchema: z.object({
    language: z.string(),
    decoded_text: z.string(),
  }),
  execute: async ({ inputData }) =>
    instrumentStage(STEP_IDS.DECODE, inputData, async () => {
    if (inputData.audio_url) {
      if (!process.env.ELEVENLABS_API_KEY) {
        throw new STTError('ELEVENLABS_API_KEY is required for audio transcription')
      }
      const audioUrl = inputData.audio_url!
      const isRemote = audioUrl.startsWith('http://') || audioUrl.startsWith('https://')
      // Construct the client ONCE per call, not per retry attempt (review #6).
      const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! })
      let result: Awaited<ReturnType<InstanceType<typeof ElevenLabsClient>['speechToText']['convert']>>
      try {
        result = await withRetry(async () => {
          if (isRemote) {
            return client.speechToText.convert({ modelId: 'scribe_v2', sourceUrl: audioUrl })
          }
          // Local file — read to Buffer and pass with metadata.
          // Bun detects as runtime "bun" (not "node"), so createReadStream breaks;
          // Buffer → Blob conversion works correctly in both environments.
          const ext = audioUrl.split('.').pop()?.toLowerCase() ?? ''
          const contentType = AUDIO_MIME[ext] ?? 'application/octet-stream'
          const data = readFileSync(audioUrl)
          const filename = audioUrl.split('/').pop() ?? 'audio'
          return client.speechToText.convert({ modelId: 'scribe_v2', file: { data, contentType, filename } })
        }, 'STT')
      } catch (err: any) {
        throw new STTError(err instanceof Error ? err.message : String(err))
      }
      const decoded_text = (result.text ?? '').normalize('NFC')
      // ElevenLabs returns ISO 639-3 (e.g. "eng", "hin") — map to our 2-letter codes
      const langMap: Record<string, string> = { hin: 'hi', guj: 'gu', ben: 'bn', tam: 'ta', eng: 'en' }
      const language = langMap[result.languageCode ?? ''] ?? result.languageCode ?? 'en'
      return { language, decoded_text }
    }

    const decoded_text = (inputData.message ?? '').normalize('NFC')
    return { language: detectLanguage(decoded_text), decoded_text }
    }),
})
