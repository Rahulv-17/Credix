/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { firstYearNote, mapPartnerRow } from '../tools/card-catalog'

/**
 * Merchant level reward maths. This is money arithmetic, so it is computed in the tool rather than left
 * to the model, for the same reason getCardFees returns first_year_note: a wrong figure here is a figure
 * a customer would act on. Every case below is a real shape found in the live catalog.
 */
/**
 * A tool-output string the agent is told to quote must contain facts only, never an instruction aimed at
 * the model, because whatever is in it can be read out verbatim. Three separate leaks of this shape were
 * caught on PR #20 (`first_year_note`, `math_note`, `no_data_note`), so it is asserted as a CLASS here
 * rather than fixed one string at a time.
 *
 * Deliberately matched on speech verbs rather than a bare /do not/: math_note legitimately says
 * "Transactions under ₹249 do not qualify", which is a fact about transactions, not an order to the model.
 */
const MODEL_DIRECTIVE = /\b(do not|don't|never)\s+(state|add|say|mention|quote|present|write|report)\b|\bso say it\b|\bsay it that way\b/i

const row = (over: Partial<Parameters<typeof mapPartnerRow>[2]> = {}) => ({
  partner_code: 'swiggy',
  reward_rate: '0.10',
  reward_cap_value_month: null,
  reward_cap_spend_month: null,
  is_instant_discount: false,
  note: null,
  rate_variant: 'default',
  applicable_days: null,
  min_transaction_value: null,
  channel_gated: false,
  shared_cap_group: null,
  override_reward_currency: null,
  earn_quantum_points: null,
  earn_quantum_amount: null,
  ...over,
})

describe('merchant reward maths', () => {
  test('a category rate is labelled as one, so it is never sold as a merchant deal', () => {
    // Verified live 2026-08-05: neither Swiggy card has a partner row for swiggy; the real 5% with a
    // ₹1,500 cap lives in card_category under online_food. With the merchant lookup empty the model
    // invented "capped at ₹750". The fallback returns the real row, labelled.
    const r = mapPartnerRow('hdfc_swiggy_orange', 'Swiggy ORNGE', row({
      reward_rate: '0.05', reward_cap_value_month: 1500, source: 'category_rate', category_code: 'online_food',
    }) as any, 15000)
    expect(r.source).toBe('category_rate')
    expect(r.category_code).toBe('online_food')
    expect(r.computed!.monthly_value).toBe(750)   // 5% of 15000, under the real cap
    expect(r.computed!.binding_cap).toBe('none')  // the ₹1,500 cap does NOT bind here
    expect(r.computed!.math_note).toContain('not a deal negotiated with this merchant')
  })

  test('the real cap binds at higher spend, which the invented ₹750 ceiling hid', () => {
    const c = mapPartnerRow('hdfc_swiggy_orange', 'Swiggy ORNGE', row({
      reward_rate: '0.05', reward_cap_value_month: 1500, source: 'category_rate', category_code: 'online_food',
    }) as any, 40000).computed!
    expect(c.monthly_value).toBe(1500)
    expect(c.binding_cap).toBe('value_cap')
    expect(c.spend_headroom).toBe(10000)  // only the first ₹30,000 earns
  })

  test('a category excluded from rewards says so outright', () => {
    const c = mapPartnerRow('c1', 'Card One', row({ source: 'category_rate', rewards_excluded: true }) as any, 10000).computed!
    expect(c.math_note).toContain('NO rewards')
  })

  test('no spend supplied means no arithmetic, only the facts', () => {
    const r = mapPartnerRow('c1', 'Card One', row())
    expect(r.computed).toBeNull()
    expect(r.reward_rate).toBe(0.1)
  })

  test('a whole percent prints without decimals, even the float-unsafe rates', () => {
    // PR #20 review flagged the `rate * 100 % 1 === 0` test. 8 of the 100 two-decimal rates fail it:
    // 0.07 * 100 is 7.000000000000001 and 0.29 * 100 is 28.999999999999996, so these plausible reward
    // rates printed as "7.00%" and "29.00%" to the user. (The review's own example, 0.3, is exact in JS.)
    expect(mapPartnerRow('c1', 'C', row({ reward_rate: '0.07' }), 10000).computed!.math_note).toContain('7% earns')
    expect(mapPartnerRow('c1', 'C', row({ reward_rate: '0.29' }), 10000).computed!.math_note).toContain('29% earns')
    expect(mapPartnerRow('c1', 'C', row({ reward_rate: '0.14' }), 10000).computed!.math_note).toContain('14% earns')
    // a genuine fraction still shows its decimals
    expect(mapPartnerRow('c1', 'C', row({ reward_rate: '0.025' }), 10000).computed!.math_note).toContain('2.5% earns')
  })

  test('a decimal spend is rounded, so the field and the prose cannot disagree', () => {
    // The schema accepts any positive number and everything downstream rounds, so 15000.6 used to leave
    // computed.monthly_spend at 15000.6 while math_note printed ₹15,001.
    const c = mapPartnerRow('c1', 'C', row({ reward_rate: '0.10' }), 15000.6).computed!
    expect(c.monthly_spend).toBe(15001)
    expect(c.math_note).toContain('₹15,001')
    expect(c.monthly_value).toBe(1500) // 10% of 15001, rounded
  })

  test('uncapped: spend times rate, annualised', () => {
    const c = mapPartnerRow('c1', 'Card One', row(), 15000).computed!
    expect(c.monthly_value).toBe(1500)
    expect(c.annual_value).toBe(18000)
    expect(c.binding_cap).toBe('none')
  })

  test('value cap binds, and the wasted spend is quantified', () => {
    // Axis ACE at Swiggy: 4 percent with a ₹500 monthly cap. 15000 x 0.04 = 600, capped to 500.
    const c = mapPartnerRow('ace', 'Axis ACE', row({ reward_rate: '0.04', reward_cap_value_month: 500 }), 15000).computed!
    expect(c.monthly_value).toBe(500)
    expect(c.annual_value).toBe(6000)
    expect(c.binding_cap).toBe('value_cap')
    expect(c.spend_headroom).toBe(2500) // ₹12,500 earns the cap; the rest earns nothing
    expect(c.math_note).toContain('earns nothing extra')
  })

  test('spend cap binds: only the first slice of spend earns', () => {
    const c = mapPartnerRow('c1', 'Card One', row({ reward_cap_spend_month: 5000 }), 15000).computed!
    expect(c.earning_spend).toBe(5000)
    expect(c.monthly_value).toBe(500)
    expect(c.binding_cap).toBe('spend_cap')
    expect(c.spend_headroom).toBe(10000)
  })

  test('an offer running all 7 days is not a restriction, so it is not demoted', () => {
    // PR #20 review: dayLabel returned "every day", which is truthy, so is_upper_bound was set and a
    // "treat this as a ceiling" caveat was appended. A card enumerating all 7 days therefore ranked below
    // an identical card that left applicable_days null.
    const r = mapPartnerRow('c1', 'Card One', row({ applicable_days: [1, 2, 3, 4, 5, 6, 7] }), 15000)
    expect(r.applicable_days_label).toBeNull()
    expect(r.computed!.is_upper_bound).toBe(false)
    expect(r.computed!.math_note).not.toContain('ceiling')
    // ranked alongside a row with no day column at all, not below it
    const bare = mapPartnerRow('c1', 'Card One', row(), 15000)
    expect(r.computed!.annual_value).toBe(bare.computed!.annual_value)
    expect(r.computed!.is_upper_bound).toBe(bare.computed!.is_upper_bound)
  })

  test('seven duplicate entries are one day, not a full week', () => {
    const r = mapPartnerRow('c1', 'Card One', row({ applicable_days: [3, 3, 3, 3, 3, 3, 3] }), 15000)
    expect(r.applicable_days_label).toBe('Wednesday only')
    expect(r.computed!.is_upper_bound).toBe(true)
  })

  test('an unrecognised day code is surfaced, not silently dropped', () => {
    // Dropping it would read as "no restriction" and overstate the offer.
    const r = mapPartnerRow('c1', 'Card One', row({ applicable_days: [9] }), 15000)
    expect(r.applicable_days_label).toBe('day 9 only')
    expect(r.computed!.is_upper_bound).toBe(true)
  })

  test('a day restricted offer is flagged as a ceiling, never an expectation', () => {
    // Axis Horizon at Swiggy is days=[3], Wednesday only, and an instant discount.
    const r = mapPartnerRow('hz', 'Axis Horizon', row({ applicable_days: [3], is_instant_discount: true }), 15000)
    expect(r.applicable_days_label).toBe('Wednesday only')
    expect(r.computed!.is_upper_bound).toBe(true)
    expect(r.computed!.math_note).toContain('ceiling')
    expect(r.computed!.math_note).toContain('does not accumulate')
  })

  test('conditions that change the answer all reach the note', () => {
    const c = mapPartnerRow(
      'c1',
      'Card One',
      row({ min_transaction_value: 249, channel_gated: true, shared_cap_group: 'grp', override_reward_currency: 'EDGE points' }),
      15000,
    ).computed!
    expect(c.math_note).toContain('249')
    expect(c.math_note).toContain('portal')
    expect(c.math_note).toContain('shared')
    expect(c.math_note).toContain('EDGE points')
    expect(c.is_upper_bound).toBe(true) // a program currency's rupee value depends on redemption
    // PR #20 review: this used to read "paid in EDGE points, not rupees", which contradicted the ₹ figures
    // printed in the same note and the tool's own contract that reward_rate is value-back per rupee. The
    // note must frame those figures as an estimate, never deny them.
    expect(c.math_note).not.toContain('not rupees')
    expect(c.math_note).toContain('estimate')
    expect(c.math_note).toContain('₹') // the rupee estimate is still stated, not withheld
  })

  test('points that accrue per block round down, so the figure is an upper bound', () => {
    const c = mapPartnerRow('uno', 'PhonePe Uno', row({ reward_rate: '0.01', earn_quantum_points: '1', earn_quantum_amount: '100' }), 15000).computed!
    expect(c.math_note).toContain('rounded down')
    expect(c.math_note).toContain('1 per ₹100')
    expect(c.is_upper_bound).toBe(true)
  })

  test('a block size with no points count still explains itself, never a silent demotion', () => {
    // PR #20 review: is_upper_bound fired on earn_quantum_amount alone while the note required BOTH
    // halves, so this row was ranked below dependable ones by rankByValue and said nothing about why.
    // The flag is kept (a block size means the earn rounds DOWN, and dropping that overstates the row);
    // the note degrades to state the rounding without inventing a points figure.
    const c = mapPartnerRow('c1', 'Card One', row({ earn_quantum_amount: '150', earn_quantum_points: null }), 15000).computed!
    expect(c.is_upper_bound).toBe(true)
    expect(c.math_note).toContain('rounded down')
    expect(c.math_note).toContain('₹150')
    expect(c.math_note).not.toContain('null') // the missing points count must not print
  })

  test('math_note is facts only, across every branch that can fire', () => {
    // Every condition at once, so each appended sentence is exercised. "so say it that way" used to ride
    // on the category_rate branch, which is the string the agent is told to quote to the user.
    const c = mapPartnerRow('c1', 'Card One', row({
      reward_rate: '0.05',
      reward_cap_value_month: 500,
      reward_cap_spend_month: 8000,
      min_transaction_value: 249,
      applicable_days: [3],
      is_instant_discount: true,
      channel_gated: true,
      shared_cap_group: 'grp',
      override_reward_currency: 'EDGE points',
      earn_quantum_points: '2',
      earn_quantum_amount: '150',
      source: 'category_rate',
      category_code: 'online_food',
      rewards_excluded: true,
    }) as any, 15000).computed!
    expect(c.math_note).not.toMatch(MODEL_DIRECTIVE)
    expect(c.math_note).toContain('not a deal negotiated with this merchant')
    expect(c.math_note).toContain('do not qualify') // the legitimate factual "do not", still allowed
  })

  test('multiple rates for one merchant keep their variant label', () => {
    // icici_times_black at iShop is 24 percent hotels, 12 percent flights, 12 percent vouchers. Without
    // the label the rows are indistinguishable apart from the number.
    const hotels = mapPartnerRow('tb', 'Times Black', row({ reward_rate: '0.24', rate_variant: 'hotels' }), 20000)
    expect(hotels.rate_variant).toBe('hotels')
    expect(hotels.computed!.annual_value).toBe(57600)
  })
})

/**
 * The year-one sentence getCardFees ships with the numbers. This is the defect that started the prompt
 * work: asked for the first year cost of HDFC Infinia, the reply summed joining and annual and said
 * ₹29,500. The note is quoted to the user, so it is asserted as user-facing text: ₹ sign, Indian
 * grouping, and no instruction to the model inside it (PR #20 review).
 */
describe('year one fee note', () => {
  test('joining and annual both published: year one is the joining fee alone', () => {
    // HDFC Infinia, ₹12,500 each, so ₹14,750 with GST. Never ₹29,500.
    const note = firstYearNote(14750, 14750)!
    expect(note).toContain('Year one costs ₹14,750')
    expect(note).toContain('renewal in year 2')
    expect(note).not.toContain('29,500')
  })

  test('the note carries no instruction to the model, only facts', () => {
    // The "never sum the two" rule lives in CREDIT_CARD_ADDENDUM. A "Do NOT" here was liable to be read
    // out verbatim, and the ₹ sign is a persona rule for anything the user sees.
    for (const note of [firstYearNote(14750, 14750), firstYearNote(2360, null), firstYearNote(null, 5900)]) {
      expect(note).not.toMatch(MODEL_DIRECTIVE)
      expect(note).toContain('₹')
    }
  })

  test('joining fee only, and annual fee only', () => {
    expect(firstYearNote(2360, null)).toContain('No separate annual fee is published')
    expect(firstYearNote(null, 5900)).toBe(
      'No joining fee is published, so year one is the annual fee of ₹5,900 with GST.',
    )
  })

  test('a card with neither fee published gets no note, never a fabricated zero', () => {
    expect(firstYearNote(null, null)).toBeNull()
  })
})
