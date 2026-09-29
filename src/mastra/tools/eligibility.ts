import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

/**
 * checkCardEligibility — pure decision tree, no I/O.
 *
 * The masked bureau profile is injected into the agent's prompt; this tool only scores the two
 * numbers the agent extracts from it. Keeping it pure makes the tiering rule trivially testable
 * and deterministic.
 *
 * Tiers (digits-only reasons — TTS mispronounces spelled numbers):
 *   cibil_score >= 750 AND monthly_income >= 25000  → premium
 *   cibil_score >= 650                              → standard
 *   otherwise                                       → secured
 */
export const checkCardEligibility = createTool({
  id: 'checkCardEligibility',
  description:
    'Decide a credit-card tier (premium/standard/secured) from a CIBIL score and monthly income. Pure rule, no data fetch.',
  inputSchema: z.object({
    cibil_score: z.number(),
    monthly_income: z.number(),
  }),
  outputSchema: z.object({
    tier: z.enum(['premium', 'standard', 'secured']),
    reason: z.string(),
  }),
  execute: async (inputData) => {
    const { cibil_score, monthly_income } = inputData

    if (cibil_score >= 750 && monthly_income >= 25000) {
      return {
        tier: 'premium' as const,
        reason: `Score ${cibil_score} >= 750 and income ${monthly_income} >= 25000 qualify for a premium card.`,
      }
    }
    if (cibil_score >= 650) {
      return {
        tier: 'standard' as const,
        reason: `Score ${cibil_score} >= 650 qualifies for a standard card; premium needs score 750 and income 25000.`,
      }
    }
    return {
      tier: 'secured' as const,
      reason: `Score ${cibil_score} is below 650, so a secured card is the fit while the score is built up.`,
    }
  },
})
