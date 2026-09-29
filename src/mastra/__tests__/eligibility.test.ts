/// <reference types="bun-types" />
import { describe, it, expect } from 'bun:test'
import { checkCardEligibility } from '../tools/eligibility'

// See tools.test.ts — execTool bypasses Tool.execute strict-mode union/arity issues.
const execTool = (tool: any, inputData: any) => tool.execute(inputData)

describe('checkCardEligibility', () => {
  it('score 750 + income 25000 → premium (both boundaries inclusive)', async () => {
    const r = await execTool(checkCardEligibility, { cibil_score: 750, monthly_income: 25000 })
    expect(r.tier).toBe('premium')
  })

  it('score 800 + income 100000 → premium', async () => {
    const r = await execTool(checkCardEligibility, { cibil_score: 800, monthly_income: 100000 })
    expect(r.tier).toBe('premium')
  })

  it('score 750 + income 24999 → standard (income just below premium)', async () => {
    const r = await execTool(checkCardEligibility, { cibil_score: 750, monthly_income: 24999 })
    expect(r.tier).toBe('standard')
  })

  it('score 650 + high income → standard (score boundary inclusive)', async () => {
    const r = await execTool(checkCardEligibility, { cibil_score: 650, monthly_income: 999999 })
    expect(r.tier).toBe('standard')
  })

  it('score 649 → secured (just below standard)', async () => {
    const r = await execTool(checkCardEligibility, { cibil_score: 649, monthly_income: 999999 })
    expect(r.tier).toBe('secured')
  })

  it('low score + low income → secured', async () => {
    const r = await execTool(checkCardEligibility, { cibil_score: 500, monthly_income: 10000 })
    expect(r.tier).toBe('secured')
  })

  it('reason states thresholds in digits (no spelled numbers)', async () => {
    const r = await execTool(checkCardEligibility, { cibil_score: 720, monthly_income: 30000 })
    expect(r.reason).toMatch(/\d/)
    expect(r.reason.toLowerCase()).not.toContain('seven hundred')
  })
})
