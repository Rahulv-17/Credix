/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, mock } from 'bun:test'

// Stub pg's Pool (a bare specifier, so mock.module intercepts it — see lessons.md). It captures the
// last query and returns rows from a mutable `responder` the tests drive; the multi-query tools
// (fees/benefits/partner-rates each issue several queries) route by SQL text via the responder.
let lastQuery: { text: string; params: unknown[] } | null = null
let nextRows: unknown[] = []
let throwErr: Error | null = null
let responder: (text: string, params: unknown[]) => unknown[] = () => nextRows

class StubPool {
  on() {}
  async query(text: string, params: unknown[] = []) {
    lastQuery = { text, params }
    if (throwErr) throw throwErr
    return { rows: responder(text, params) }
  }
}

mock.module('pg', () => ({ Pool: StubPool }))

// Import AFTER the mock is registered so catalog-db builds the stubbed pool. The pool is lazy, so
// DATABASE_URL only needs to be set before a tool executes; beforeEach sets it per-test. Setting it
// at module load would leak 'postgres://test' process-wide into other suites (e.g. the live test's
// DATABASE_URL gate), so it stays out of the top level.
const { getCardCriteria, getCardFees, getCardPartnerRates, getCardBenefits, getCardDetails, getCardFullProfile, compareCards } = await import(
  '../tools/card-catalog'
)
const { resetCatalogPoolForTests } = await import('../lib/catalog-db')

const exec = (tool: any, input: any) => tool.execute(input)

const sampleRow = {
  name: 'HDFC Regalia Gold',
  issuer_name: 'HDFC Bank',
  tier: 'premium',
  annual_fee: 2500,
  income_floor_monthly: 100000,
  score_floor: 750,
  ntc_ok: false,
  invite_only: false,
  fx_markup_pct: 0.02,
  interest_free_days_max: 50,
  accepting_new_applications: true,
}

beforeEach(() => {
  lastQuery = null
  nextRows = []
  throwErr = null
  responder = () => nextRows
  process.env.DATABASE_URL = 'postgres://test'
  resetCatalogPoolForTests()
})

describe('getCardCriteria', () => {
  it('returns ok:true with matched cards via the cardMatchSql token matcher', async () => {
    nextRows = [sampleRow]
    const r = await exec(getCardCriteria, { cardName: 'Regalia' })
    expect(r.ok).toBe(true)
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0].name).toBe('HDFC Regalia Gold')
    // cardMatchSql passes the raw query as $1 (exact-id/name match) + escaped tokens, not a %LIKE% string.
    expect(lastQuery?.params[0]).toBe('Regalia')
    expect(lastQuery?.text).toContain('word_similarity')
    // accepting_new_applications is a required boolean in the output schema but the column is nullable
    // (ordering relies on IS NOT FALSE), so it MUST be coalesced or a NULL row breaks output validation.
    expect(lastQuery?.text).toContain('COALESCE(accepting_new_applications, true)')
  })

  it('passes employmentType as the LAST param to the income-floor column selector', async () => {
    nextRows = [sampleRow]
    await exec(getCardCriteria, { cardName: 'Atlas', employmentType: 'salaried' })
    // employmentType rides after cardMatchSql's own params (raw + tokens + fuzzy), so it is last.
    expect(lastQuery?.params.at(-1)).toBe('salaried')
    expect(lastQuery?.text).toContain("WHEN 'salaried'")
  })

  it('defaults employmentType to null (SQL picks the lower floor)', async () => {
    nextRows = [sampleRow]
    await exec(getCardCriteria, { cardName: 'Kotak' })
    expect(lastQuery?.params.at(-1)).toBeNull()
  })

  it('returns ok:false and points to exaSearch when no card matches', async () => {
    nextRows = []
    const r = await exec(getCardCriteria, { cardName: 'Nonexistent' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('exaSearch')
    expect(r.cards).toBeUndefined()
  })

  it('fails soft (ok:false) on a DB error, never throws', async () => {
    throwErr = new Error('connection refused')
    const r = await exec(getCardCriteria, { cardName: 'Regalia' })
    expect(r.ok).toBe(false)
    // never leak the raw DB error (hostnames/TLS/auth) to the model or user; message stays generic
    expect(r.message).not.toContain('connection refused')
    expect(r.message).toContain('temporarily unavailable')
  })

  it('returns CATALOG_DB_UNAVAILABLE when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL
    resetCatalogPoolForTests()
    const r = await exec(getCardCriteria, { cardName: 'Regalia' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('not configured')
  })
})

describe('getCardFees', () => {
  const feeRow = {
    id: 'hdfc_infinia',
    name: 'HDFC Infinia Credit Card',
    issuer_name: 'HDFC Bank',
    joining_fee: 12500,
    joining_fee_waiver_spend: null,
    annual_fee: 12500,
    annual_fee_waiver_spend: 1000000,
    addon_fee: null,
    fx_markup_pct: '0.02', // pg returns numeric as string
    dcc_pct: null,
    interest_monthly_pct: '0.0349',
    interest_apr_pct: '0.4188',
    interest_free_days_max: 50,
    mad_pct: '0.05',
    mad_min: 200,
    emi_conversion_fee_pct: null,
    no_cost_emi_note: null,
    cash_advance_available: true,
    cash_advance_pct: '0.025',
    cash_advance_min: 500,
    late_payment_slabs: [],
    misc_fees: {},
    notes: 'Metal card.',
  }
  // main fee SELECT carries 'joining_fee'; resolveCardCandidates is 'SELECT id, name FROM catalog.card'
  const feeResponder = (text: string) =>
    text.includes('joining_fee') ? [feeRow] : text.includes('SELECT id, name FROM catalog.card') ? [{ id: 'hdfc_infinia', name: 'HDFC Infinia Credit Card' }] : []

  it('parses numeric (string) columns to numbers and computes GST-inclusive totals', async () => {
    responder = feeResponder
    const r = await exec(getCardFees, { card: 'Infinia' })
    expect(r.found).toBe(true)
    expect(r.fx_markup_pct).toBe(0.02) // parsed from '0.02'
    expect(r.cash_advance_pct).toBe(0.025)
    expect(r.annual_fee_with_gst).toBe(Math.round(12500 * 1.18)) // 14750
    expect(r.joining_fee_with_gst).toBe(14750)
  })

  it('drops the picked card from other_matches', async () => {
    responder = feeResponder
    const r = await exec(getCardFees, { card: 'Infinia' })
    expect(r.other_matches.some((m: any) => m.id === 'hdfc_infinia')).toBe(false)
  })

  it('returns found:false pointing to exaSearch when no card matches', async () => {
    responder = () => []
    const r = await exec(getCardFees, { card: 'zzz' })
    expect(r.found).toBe(false)
    expect(r.error).toContain('exaSearch')
  })

  it('fails soft (found:false) on a DB error', async () => {
    throwErr = new Error('connection reset')
    const r = await exec(getCardFees, { card: 'Infinia' })
    expect(r.found).toBe(false)
    expect(r.error).not.toContain('connection reset')
    expect(r.error).toContain('temporarily unavailable')
  })
})

describe('getCardPartnerRates', () => {
  it('card+partner mode parses reward_rate and returns card_partner mode', async () => {
    responder = (text: string) =>
      text.includes('card_partner_rate')
        ? [{ partner_code: 'amazon', reward_rate: '0.05', reward_cap_value_month: 1000, reward_cap_spend_month: null, is_instant_discount: false, note: null }]
        : text.includes('SELECT id, name FROM catalog.card')
          ? [{ id: 'sbi_cashback', name: 'SBI Cashback Credit Card' }]
          : []
    const r = await exec(getCardPartnerRates, { card: 'Cashback', partner: 'amazon' })
    expect(r.mode).toBe('card_partner')
    expect(r.rows[0].reward_rate).toBe(0.05)
    expect(r.rows[0].partner_code).toBe('amazon')
  })

  it('partner-only reverse lookup returns partner_all mode with card names', async () => {
    responder = (text: string) =>
      text.includes('card_partner_rate')
        ? [{ card_id: 'sbi_cashback', card_name: 'SBI Cashback Credit Card', partner_code: 'amazon', reward_rate: '0.05', reward_cap_value_month: null, reward_cap_spend_month: null, is_instant_discount: false, note: null }]
        : []
    const r = await exec(getCardPartnerRates, { partner: 'amazon' })
    expect(r.mode).toBe('partner_all')
    expect(r.rows[0].card_name).toBe('SBI Cashback Credit Card')
  })

  it('errors when neither card nor partner is given', async () => {
    const r = await exec(getCardPartnerRates, {})
    expect(r.error).toContain('at least one')
  })

  // PR #20 review. monthly_spend means spend at ONE merchant. In card-only mode the rows span every
  // partner on the card, so applying it there turned one real figure ("I spend 15k at Swiggy") into a
  // full earn calculation for Amazon, IRCTC and BookMyShow too: up to 50 fabricated money answers.
  it('card-only mode ignores monthly_spend, so unrelated merchants get no invented maths', async () => {
    responder = (text: string) =>
      text.includes('card_partner_rate')
        ? [
            { partner_code: 'swiggy', reward_rate: '0.05', reward_cap_value_month: null, reward_cap_spend_month: null, is_instant_discount: false, note: null },
            { partner_code: 'irctc', reward_rate: '0.01', reward_cap_value_month: null, reward_cap_spend_month: null, is_instant_discount: false, note: null },
          ]
        : text.includes('SELECT id, name FROM catalog.card')
          ? [{ id: 'sbi_cashback', name: 'SBI Cashback Credit Card' }]
          : []
    const r = await exec(getCardPartnerRates, { card: 'Cashback', monthly_spend: 15000 })
    expect(r.mode).toBe('card_all')
    expect(r.rows).toHaveLength(2)
    for (const row of r.rows) expect(row.computed).toBeNull()
    // The facts still come through; it is only the per-merchant arithmetic that is withheld.
    expect(r.rows[0].reward_rate).toBe(0.05)
  })

  it('card+partner mode DOES apply monthly_spend, since one merchant is fixed', async () => {
    responder = (text: string) =>
      text.includes('card_partner_rate')
        ? [{ partner_code: 'swiggy', reward_rate: '0.05', reward_cap_value_month: 1500, reward_cap_spend_month: null, is_instant_discount: false, note: null }]
        : text.includes('SELECT id, name FROM catalog.card')
          ? [{ id: 'sbi_cashback', name: 'SBI Cashback Credit Card' }]
          : []
    const r = await exec(getCardPartnerRates, { card: 'Cashback', partner: 'swiggy', monthly_spend: 15000 })
    expect(r.mode).toBe('card_partner')
    expect(r.rows[0].computed?.monthly_value).toBe(750) // 5% of 15000, under the 1500 cap
  })

  it('errors (card not found) pointing to exaSearch', async () => {
    responder = () => []
    const r = await exec(getCardPartnerRates, { card: 'zzz' })
    expect(r.error).toContain('exaSearch')
  })

  it('fails soft on a DB error without leaking the raw message', async () => {
    throwErr = new Error('getaddrinfo ENOTFOUND db.internal.host')
    const r = await exec(getCardPartnerRates, { card: 'Cashback', partner: 'amazon' })
    expect(r.rows).toEqual([])
    expect(r.error).not.toContain('db.internal.host')
    expect(r.error).toContain('temporarily unavailable')
  })
})

describe('getCardBenefits', () => {
  const cardRow = {
    id: 'axis_atlas',
    name: 'Axis Bank Atlas Credit Card',
    network_tier: null,
    fuel_waiver_pct: null,
    fuel_waiver_txn_min: null,
    fuel_waiver_txn_max: null,
    fuel_waiver_annual_cap: null,
    notes: 'Miles card.',
  }
  const benefitsResponder = (text: string) => {
    if (text.includes('fuel_waiver_pct')) return [cardRow] // main card SELECT
    if (text.includes('FROM catalog.card_benefit')) return [{ benefit_type: 'welcome', title: 'Welcome miles', description: null, value_inr: '2500', sort_order: 1, recurrence: 'once', milestone_period: null }]
    if (text.includes('FROM catalog.card_lounge')) return [{ network: null, lounge_type: 'domestic', visits_per_period: 8, period: 'quarterly', guest_passes: 0, spend_required: null, access_mechanism: null, tier: null, spend_requirement_period: null }]
    if (text.includes('SELECT id, name FROM catalog.card')) return [{ id: 'axis_atlas', name: 'Axis Bank Atlas Credit Card' }]
    return []
  }

  it('parses value_inr and synthesizes a verified lounge entry from card_lounge', async () => {
    responder = benefitsResponder
    const r = await exec(getCardBenefits, { card: 'Atlas' })
    expect(r.found).toBe(true)
    const welcome = r.benefits.find((b: any) => b.benefit_type === 'welcome')
    expect(welcome.value_inr).toBe(2500) // parsed from '2500'
    const lounge = r.benefits.find((b: any) => b.title === 'Lounge Access (verified)')
    expect(lounge).toBeDefined()
    expect(lounge.description).toContain('Domestic')
    expect(r.grouped.lounge).toBeDefined()
  })

  it('returns found:false pointing to exaSearch when no card matches', async () => {
    responder = () => []
    const r = await exec(getCardBenefits, { card: 'zzz' })
    expect(r.found).toBe(false)
    expect(r.error).toContain('exaSearch')
  })
})

describe('getCardDetails', () => {
  const cardRow = {
    id: 'hdfc_infinia',
    name: 'HDFC Infinia Credit Card',
    issuer_name: 'HDFC Bank',
    network: 'Visa',
    tier: 'super_premium',
    co_brand_partner: null,
    joining_fee: 12500,
    annual_fee: 12500,
    joining_fee_waiver_spend: null,
    annual_fee_waiver_spend: 1000000,
    addon_fee: null,
    fx_markup_pct: '0.02',
    dcc_pct: null,
    reward_currency: 'RP',
    reward_program_name: 'Reward Points',
    point_value_paisa: 100,
    points_validity_months: 36,
    redemption_options: [],
    fuel_waiver_pct: '0.01',
    fuel_waiver_txn_min: 400,
    fuel_waiver_txn_max: 5000,
    fuel_waiver_annual_cap: 1000,
    income_floor_monthly_salaried: 250000,
    income_floor_monthly_selfemployed: 300000,
    score_floor: 750,
    invite_only: false,
    ntc_ok: false,
    no_cost_emi_available: true,
    notes: 'Metal card.',
    populate_status: 'complete',
    transfer_annual_cap_total: 200000,
    points_forfeiture_conditions: null,
    addon_free_count: 3,
    addon_earns_rewards: true,
  }
  const detailsResponder = (text: string) => {
    if (text.includes('co_brand_partner')) return [cardRow] // main card SELECT
    if (text.includes('catalog.card_category')) return [{ category_code: 'dining', display_name: 'Dining', reward_rate: '0.033', rewards_excluded: false, note: null }]
    if (text.includes('catalog.card_lounge')) return [{ network: 'Visa', lounge_type: 'domestic', visits_per_period: null, period: 'yearly', guest_passes: 0, spend_required: null, spend_requirement_period: null }]
    if (text.includes('catalog.card_benefit')) return [{ benefit_type: 'milestone', title: 'Spend milestone', description: '10k points', value_inr: '15000', milestone_spend: '500000', milestone_period: 'yearly', recurrence: 'annual' }]
    if (text.includes('catalog.card_transfer_partner')) return [{ program_name: 'Air India', program_type: 'airline', points_in: 1, miles_out: 1, note: null }]
    if (text.includes('catalog.card_transfer_cap')) return [{ partner_group: 'airlines', cap_value: '100000', cap_period: 'yearly' }]
    if (text.includes('SELECT id, name FROM catalog.card')) return [{ id: 'hdfc_infinia', name: 'HDFC Infinia Credit Card' }]
    return []
  }

  it('aggregates fees/rewards/lounge/transfers with numeric coercion', async () => {
    responder = detailsResponder
    const r = await exec(getCardDetails, { card: 'Infinia' })
    expect(r.found).toBe(true)
    expect(r.fees.fx_markup_pct).toBe(0.02) // parsed from '0.02'
    expect(r.rewards.earn_rates[0].reward_rate).toBe(0.033)
    expect(r.rewards.milestones[0].benefit_value_inr).toBe(15000) // coerced from '15000'
    expect(r.rewards.milestones[0].trigger_spend).toBe(500000)
    expect(r.lounge.domestic_unlimited).toBe(true) // visits_per_period null => unlimited
    expect(r.rewards.transfer_caps[0].cap_value).toBe(100000)
    expect(r.eligibility.income_floor_salaried).toBe(250000)
  })

  it('returns found:false pointing to exaSearch when no card matches', async () => {
    responder = () => []
    const r = await exec(getCardDetails, { card: 'zzz' })
    expect(r.found).toBe(false)
    expect(r.error).toContain('exaSearch')
  })

  it('fails soft on a DB error', async () => {
    throwErr = new Error('pool timeout')
    const r = await exec(getCardDetails, { card: 'Infinia' })
    expect(r.found).toBe(false)
    expect(r.error).not.toContain('pool timeout')
    expect(r.error).toContain('temporarily unavailable')
  })
})

describe('compareCards', () => {
  const mkCard = (id: string, name: string, fee: number) => ({
    id,
    name,
    issuer_name: 'Bank',
    tier: 'premium',
    joining_fee: fee,
    annual_fee: fee,
    annual_fee_waiver_spend: null,
    fx_markup_pct: '0.035',
    income_floor_monthly_salaried: 100000,
    income_floor_monthly_selfemployed: 120000,
    score_floor: 750,
    ntc_ok: false,
  })
  // Route by params: the main card SELECT carries the card query in params[0]. Distinguish the two
  // cards by that. resolveCardCandidates + sub-queries return empty for a clean single-row compare.
  const compareResponder = (text: string, params: unknown[]) => {
    if (text.includes('FROM catalog.card\n') || (text.includes('joining_fee') && text.includes('income_floor_monthly_salaried') && text.includes('ORDER BY'))) {
      const q = String(params[0] ?? '')
      if (/atlas/i.test(q)) return [mkCard('axis_atlas', 'Axis Bank Atlas Credit Card', 5000)]
      if (/infinia/i.test(q)) return [mkCard('hdfc_infinia', 'HDFC Infinia Credit Card', 12500)]
      return []
    }
    return []
  }

  it('returns one summary per requested card', async () => {
    responder = compareResponder
    const r = await exec(compareCards, { cards: ['Infinia', 'Atlas'] })
    expect(r.error).toBeNull()
    expect(r.results).toHaveLength(2)
    expect(r.results[0].card_name).toBe('HDFC Infinia Credit Card')
    expect(r.results[1].card_name).toBe('Axis Bank Atlas Credit Card')
    expect(r.results[0].fx_markup_pct).toBe(0.035)
  })

  it('marks a missing card with its own error without failing the others', async () => {
    responder = (text: string, params: unknown[]) => {
      const q = String(params[0] ?? '')
      if ((text.includes('joining_fee') || text.includes('income_floor_monthly_salaried')) && /infinia/i.test(q)) {
        return [mkCard('hdfc_infinia', 'HDFC Infinia Credit Card', 12500)]
      }
      return []
    }
    const r = await exec(compareCards, { cards: ['Infinia', 'zzz-missing'] })
    expect(r.results).toHaveLength(2)
    const missing = r.results.find((x: any) => x.card_name === 'zzz-missing')
    expect(missing.error).toContain('exaSearch')
    const found = r.results.find((x: any) => x.card_id === 'hdfc_infinia')
    expect(found.error).toBeNull()
  })

  it('returns CATALOG_DB_UNAVAILABLE when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL
    resetCatalogPoolForTests()
    const r = await exec(compareCards, { cards: ['Infinia', 'Atlas'] })
    expect(r.error).toContain('not configured')
    expect(r.results).toHaveLength(0)
  })
})

describe('getCardFullProfile', () => {
  // Drives getCardDetails + getCardBenefits + getCardPartnerRates through one shared responder. The
  // 'co_brand_partner' check MUST precede 'fuel_waiver_pct': getCardDetails' main SELECT carries both,
  // getCardBenefits' main SELECT carries only fuel_waiver_pct, so order disambiguates the two card rows.
  const detailsCardRow = {
    id: 'hdfc_infinia',
    name: 'HDFC Infinia Credit Card',
    issuer_name: 'HDFC Bank',
    network: 'Visa',
    tier: 'super_premium',
    co_brand_partner: null,
    joining_fee: 12500,
    annual_fee: 12500,
    joining_fee_waiver_spend: null,
    annual_fee_waiver_spend: 1000000,
    addon_fee: null,
    fx_markup_pct: '0.02',
    dcc_pct: null,
    reward_currency: 'RP',
    reward_program_name: 'Reward Points',
    point_value_paisa: 100,
    points_validity_months: 36,
    redemption_options: [],
    fuel_waiver_pct: '0.01',
    fuel_waiver_txn_min: 400,
    fuel_waiver_txn_max: 5000,
    fuel_waiver_annual_cap: 1000,
    income_floor_monthly_salaried: 250000,
    income_floor_monthly_selfemployed: 300000,
    score_floor: 750,
    invite_only: false,
    ntc_ok: false,
    no_cost_emi_available: true,
    notes: 'Metal card.',
    populate_status: 'complete',
    transfer_annual_cap_total: 200000,
    points_forfeiture_conditions: null,
    addon_free_count: 3,
    addon_earns_rewards: true,
  }
  const benefitsCardRow = {
    id: 'hdfc_infinia',
    name: 'HDFC Infinia Credit Card',
    network_tier: 'Visa Infinite',
    fuel_waiver_pct: '0.01',
    fuel_waiver_txn_min: 400,
    fuel_waiver_txn_max: 5000,
    fuel_waiver_annual_cap: 1000,
    notes: 'Metal card.',
  }
  const fullResponder = (text: string) => {
    if (text.includes('co_brand_partner')) return [detailsCardRow] // getCardDetails main card SELECT
    if (text.includes('catalog.card_category')) return [{ category_code: 'dining', display_name: 'Dining', reward_rate: '0.033', rewards_excluded: false, note: null }]
    if (text.includes('catalog.card_transfer_partner')) return [{ program_name: 'Air India', program_type: 'airline', points_in: 1, miles_out: 1, note: null }]
    if (text.includes('catalog.card_transfer_cap')) return [{ partner_group: 'airlines', cap_value: '100000', cap_period: 'yearly' }]
    if (text.includes('catalog.card_partner_rate')) return [{ partner_code: 'amazon', reward_rate: '0.05', reward_cap_value_month: null, reward_cap_spend_month: null, is_instant_discount: false, note: null }]
    if (text.includes('fuel_waiver_pct')) return [benefitsCardRow] // getCardBenefits main card SELECT (no co_brand_partner)
    if (text.includes('catalog.card_benefit'))
      return [
        { benefit_type: 'welcome', title: 'Welcome bonus', description: null, value_inr: '2500', milestone_spend: null, milestone_period: null, sort_order: 1, recurrence: 'once' },
        { benefit_type: 'milestone', title: 'Spend milestone', description: '10k points', value_inr: '15000', milestone_spend: '500000', milestone_period: 'yearly', sort_order: 2, recurrence: 'annual' },
      ]
    if (text.includes('catalog.card_lounge')) return [{ network: 'Visa', lounge_type: 'domestic', visits_per_period: null, period: 'yearly', guest_passes: 0, spend_required: null, access_mechanism: null, tier: null, spend_requirement_period: null }]
    if (text.includes('SELECT id, name FROM catalog.card')) return [{ id: 'hdfc_infinia', name: 'HDFC Infinia Credit Card' }]
    return []
  }

  it('merges details, benefits, and partner rates for one card in a single call', async () => {
    responder = fullResponder
    const r = await exec(getCardFullProfile, { card: 'Infinia' })
    expect(r.found).toBe(true)
    expect(r.card_id).toBe('hdfc_infinia')
    // details section (getCardDetails)
    expect(r.fees.fx_markup_pct).toBe(0.02)
    expect(r.rewards.earn_rates[0].reward_rate).toBe(0.033)
    expect(r.eligibility.income_floor_salaried).toBe(250000)
    // benefits section (getCardBenefits)
    expect(r.benefits.some((b: any) => b.benefit_type === 'welcome')).toBe(true)
    expect(r.benefits_grouped.welcome).toBeDefined()
    // partner-rates section (getCardPartnerRates)
    expect(r.partner_rates[0].partner_code).toBe('amazon')
    expect(r.partner_rates[0].reward_rate).toBe(0.05)
    // insurance placeholder dropped in favour of real embedded benefits
    expect((r as any).insurance).toBeUndefined()
  })

  it('returns found:false with an exaSearch hint when the card is not found', async () => {
    responder = () => []
    const r = await exec(getCardFullProfile, { card: 'zzz' })
    expect(r.found).toBe(false)
    expect(r.error).toContain('exaSearch')
    expect(r.benefits).toEqual([])
    expect(r.partner_rates).toEqual([])
  })

  it('returns CATALOG_DB_UNAVAILABLE when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL
    resetCatalogPoolForTests()
    const r = await exec(getCardFullProfile, { card: 'Infinia' })
    expect(r.found).toBe(false)
    expect(r.error).toContain('not configured')
    expect(r.benefits).toEqual([])
  })

  it('surfaces a partial failure when a sibling section fails soft after details succeed', async () => {
    // getCardDetails + getCardPartnerRates succeed; getCardBenefits' main SELECT throws (transient DB
    // error). The card is still "found", but the empty benefits section must be reported as a partial
    // failure, not silently merged as "no benefits" (which the agent would read as "not published").
    responder = (text: string) => {
      if (text.includes('co_brand_partner')) return [detailsCardRow] // getCardDetails main SELECT (ok)
      if (text.includes('catalog.card_category')) return [{ category_code: 'dining', display_name: 'Dining', reward_rate: '0.033', rewards_excluded: false, note: null }]
      if (text.includes('catalog.card_transfer_partner')) return [{ program_name: 'Air India', program_type: 'airline', points_in: 1, miles_out: 1, note: null }]
      if (text.includes('catalog.card_transfer_cap')) return [{ partner_group: 'airlines', cap_value: '100000', cap_period: 'yearly' }]
      if (text.includes('catalog.card_partner_rate')) return [{ partner_code: 'amazon', reward_rate: '0.05', reward_cap_value_month: null, reward_cap_spend_month: null, is_instant_discount: false, note: null }]
      if (text.includes('SELECT id, name FROM catalog.card')) return [{ id: 'hdfc_infinia', name: 'HDFC Infinia Credit Card' }]
      if (text.includes('fuel_waiver_pct')) throw new Error('pool timeout') // getCardBenefits main SELECT (fails soft)
      return []
    }
    const r = await exec(getCardFullProfile, { card: 'Infinia' })
    expect(r.found).toBe(true) // details succeeded, so the card resolves
    expect(r.benefits).toEqual([]) // benefits came back empty because that lookup failed
    expect(r.partner_rates[0].partner_code).toBe('amazon') // the healthy section still merges
    expect(r.error).toBeTruthy() // partial failure surfaced instead of a false null
    expect(r.error).toContain('benefits')
    expect(r.error).not.toContain('pool timeout') // raw DB error never leaks to the model/user
  })
})
