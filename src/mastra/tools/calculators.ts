import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

export const calculateEmi = createTool({
  id: 'calculateEmi',
  description: 'Calculate equated monthly instalment (EMI). Formula: P × r × (1+r)^n / ((1+r)^n − 1)',
  inputSchema: z.object({
    principal: z.number().positive(),
    annual_rate: z.number().positive(),
    tenure_months: z.number().int().positive(),
  }),
  outputSchema: z.object({ result: z.string() }),
  execute: async (inputData) => {
    const { principal, annual_rate, tenure_months } = inputData
    const r = annual_rate / 12 / 100
    const pow = Math.pow(1 + r, tenure_months)
    const emi = (principal * r * pow) / (pow - 1)
    return { result: `EMI: ${Math.round(emi)}` }
  },
})

export const calculateFoir = createTool({
  id: 'calculateFoir',
  description: 'Calculate Fixed Obligation to Income Ratio (FOIR = obligations / income × 100)',
  inputSchema: z.object({
    monthly_obligations: z.number().min(0),
    monthly_income: z.number(),
  }),
  outputSchema: z.object({ result: z.string() }),
  execute: async (inputData) => {
    const { monthly_obligations, monthly_income } = inputData
    if (monthly_income <= 0) {
      return { result: 'Error: monthly income must be greater than 0' }
    }
    const foir = (monthly_obligations / monthly_income) * 100
    return { result: `FOIR: ${foir.toFixed(1)}%` }
  },
})
