/// <reference types="bun-types" />
import { describe, it, expect } from 'bun:test'
import { calculateEmi, calculateFoir } from '../tools/calculators'

// execTool bypasses three tsc strict-mode errors on Tool.execute:
// 1. execute?: optional — cannot call without !
// 2. execute(inputData, context) — signature requires 2 args
// 3. return type TSchemaOut | ValidationError | void — property access fails on union
const execTool = (tool: any, inputData: any) => tool.execute(inputData)

describe('calculateEmi', () => {
  it('P=100000, r=12%, n=12 → ~8884', async () => {
    const r = await execTool(calculateEmi, { principal: 100000, annual_rate: 12, tenure_months: 12 })
    const emi = parseInt(r.result.replace('EMI: ', ''))
    expect(emi).toBeGreaterThanOrEqual(8883)
    expect(emi).toBeLessThanOrEqual(8885)
  })

  it('result prefixed with "EMI: " and digit-only value', async () => {
    const r = await execTool(calculateEmi, { principal: 50000, annual_rate: 10, tenure_months: 24 })
    expect(r.result).toMatch(/^EMI: \d+$/)
  })

  it('higher rate → higher EMI', async () => {
    const low = await execTool(calculateEmi, { principal: 100000, annual_rate: 8, tenure_months: 24 })
    const high = await execTool(calculateEmi, { principal: 100000, annual_rate: 18, tenure_months: 24 })
    const emiLow = parseInt(low.result.replace('EMI: ', ''))
    const emiHigh = parseInt(high.result.replace('EMI: ', ''))
    expect(emiHigh).toBeGreaterThan(emiLow)
  })
})

describe('calculateFoir', () => {
  it('5000 obligations, 20000 income → FOIR: 25.0%', async () => {
    const r = await execTool(calculateFoir, { monthly_obligations: 5000, monthly_income: 20000 })
    expect(r.result).toBe('FOIR: 25.0%')
  })

  it('income 0 → error string, does not throw', async () => {
    const r = await execTool(calculateFoir, { monthly_obligations: 5000, monthly_income: 0 })
    expect(r.result).toMatch(/error/i)
  })

  it('income negative → error string, does not throw', async () => {
    const r = await execTool(calculateFoir, { monthly_obligations: 0, monthly_income: -100 })
    expect(r.result).toMatch(/error/i)
  })

  it('result contains % sign', async () => {
    const r = await execTool(calculateFoir, { monthly_obligations: 3000, monthly_income: 15000 })
    expect(r.result).toContain('%')
  })

  it('0 obligations → FOIR: 0.0%', async () => {
    const r = await execTool(calculateFoir, { monthly_obligations: 0, monthly_income: 20000 })
    expect(r.result).toBe('FOIR: 0.0%')
  })
})
