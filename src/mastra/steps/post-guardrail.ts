import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { AADHAAR_PATTERN, MOBILE_PATTERN, PAN_PATTERN, STEP_IDS } from '../lib/patterns'
import { instrumentStage } from '../lib/otel'

export const postGuardrailStep = createStep({
  id: STEP_IDS.POST_GUARDRAIL,
  description: 'Scrub PAN, Aadhaar, and mobile numbers from agent response before delivery',
  inputSchema: z.object({ raw_response: z.string() }),
  outputSchema: z.object({ response: z.string() }),
  execute: async ({ inputData }) =>
    instrumentStage(STEP_IDS.POST_GUARDRAIL, inputData, async () => {
    let response = inputData.raw_response

    // Reconstruct on every call — global /g regex retains lastIndex state across calls
    // causing silent misses on second invocation. Reconstruction resets lastIndex to 0.
    // Scrub Aadhaar (12 digits) before mobile (10 digits) to prevent partial Aadhaar
    // being matched as two separate mobile numbers.
    response = response.replace(new RegExp(AADHAAR_PATTERN.source, 'g'), '[REDACTED]')
    response = response.replace(new RegExp(PAN_PATTERN.source, 'g'), '[REDACTED]')
    response = response.replace(new RegExp(MOBILE_PATTERN.source, 'g'), '[REDACTED]')

    return { response }
    }),
})
