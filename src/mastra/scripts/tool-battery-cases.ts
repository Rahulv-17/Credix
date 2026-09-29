/**
 * Tool-fetch coverage cases. Data only; the runner and the reporting live in tool-battery.ts, mirroring
 * the battery.ts / battery-cases.ts split.
 *
 * Every card id, partner code and expected value below was read out of the LIVE catalog on 2026-08-05
 * before the case was written, so a failure means the tool did not fetch, never that the fixture was
 * invented. The queries are recorded in tasks/progress.md. Catalog at that point: 361 cards, 61 partners,
 * 125 card_partner_rate rows.
 *
 * A case FAILS when the tool returns its not-found or unavailable shape for input that is known to exist.
 * That is the whole point: "no error thrown" is not the same as "fetched the details".
 */

export type Need = 'none' | 'catalog' | 'user' | 'exa'

export type ToolCase = {
  id: string
  tool: string
  input: Record<string, unknown>
  /** Human-readable pass criterion. Becomes the Langfuse dataset item's expectedOutput. */
  expected: string
  needs: Need
  /** Return a one-line failure reason, or null when the fetch succeeded. */
  check: (r: any) => string | null
  /**
   * True when the tool behaved correctly but the underlying DATA does not exist for the test user, so the
   * case is inconclusive rather than failed. Keeps "no statement was ever uploaded" out of the failure
   * column, where it would read as a broken tool and hide the real defects.
   */
  nodataWhen?: (r: any) => boolean
}

// ── check helpers ─────────────────────────────────────────────────────────────────────────────────
const noErr = (r: any): string | null =>
  r?.error ? `tool returned error: ${String(r.error).slice(0, 90)}` : null

/** Named fields must be present AND non-null. The common failure is a found row with empty columns. */
const nonNull =
  (...keys: string[]) =>
  (r: any): string | null => {
    const e = noErr(r)
    if (e) return e
    if (r?.found === false) return 'found=false for a card known to exist'
    const missing = keys.filter((k) => r?.[k] === null || r?.[k] === undefined)
    return missing.length ? `null/absent: ${missing.join(', ')}` : null
  }

const rowsAtLeast =
  (n: number, mode?: string) =>
  (r: any): string | null => {
    const e = noErr(r)
    if (e) return e
    if (mode && r?.mode !== mode) return `mode was '${r?.mode}', expected '${mode}'`
    const len = Array.isArray(r?.rows) ? r.rows.length : -1
    if (len < n) return `${len} rows, expected at least ${n}${r?.no_data_note ? ' (no_data_note set)' : ''}`
    return null
  }

/** calculateEmi / calculateFoir return a single prose string, so assert the numbers reached it. */
const resultContains =
  (...needles: string[]) =>
  (r: any): string | null => {
    const s = typeof r?.result === 'string' ? r.result : ''
    if (!s) return `no result string (got ${JSON.stringify(r).slice(0, 80)})`
    const missing = needles.filter((n) => !s.includes(n))
    return missing.length ? `result missing ${missing.join(', ')} in "${s.slice(0, 90)}"` : null
  }

/** Record-shaped tools (bureau, statement, signals) signal absence with available:false. */
const availableWith =
  (...keys: string[]) =>
  (r: any): string | null => {
    if (r?.available === false) return `available=false: ${String(r?.message ?? '').slice(0, 80)}`
    const e = noErr(r)
    if (e) return e
    const missing = keys.filter((k) => r?.[k] === undefined)
    return missing.length ? `absent: ${missing.join(', ')}` : null
  }

/** A section fetch is good when the section key came back with actual content under it. */
const sectionPresent =
  (section: string) =>
  (r: any): string | null => {
    if (r?.available === false) return 'available=false'
    const e = noErr(r)
    if (e) return e
    const v = r?.[section]
    if (v === undefined) return `section key '${section}' absent; keys=${Object.keys(r ?? {}).slice(0, 6)}`
    if (v === null) return `section '${section}' is null`
    if (Array.isArray(v) && v.length === 0) return `section '${section}' is an empty array`
    if (typeof v === 'object' && Object.keys(v).length === 0) return `section '${section}' is an empty object`
    return null
  }

/** Not-found paths must fail CLEANLY: say so, and point somewhere, without inventing data. */
const cleanNotFound = (r: any): string | null => {
  if (r?.found === true) return 'found=true for a card that does not exist'
  const said = r?.error != null || r?.found === false || r?.no_data_note != null || r?.available === false
  return said ? null : `no not-found signal; got keys ${Object.keys(r ?? {}).slice(0, 8)}`
}

// Verified live 2026-08-05. Fees present on both columns:
const FEE_CARDS = ['hsbc_taj', 'amex_platinum_charge', 'axis_burgundy_private', 'axis_reserve', 'axis_magnus_burgundy']
// score_floor AND income_floor_monthly_salaried present:
const CRITERIA_CARDS = ['hdfc_tata_neu_infinity', 'amex_gold', 'icici_mmt_black', 'amex_platinum_charge', 'amex_platinum_travel']
// Most card_partner_rate rows, descending:
const RATE_CARDS = ['hdfc_pixel_play', 'amex_smartearn', 'hsbc_travelone', 'hdfc_phonepe_uno', 'sc_digismart']
// Most cards per partner, descending. Trimmed to 4 to land the suite on exactly 100 cases; tira (7 cards)
// and myntra (6) were dropped as the smallest, and both categories stay covered by zomato and flipkart.
const HOT_PARTNERS = ['zomato', 'makemytrip', 'swiggy', 'flipkart']
// Most card_benefit rows:
const BENEFIT_CARDS = ['icici_times_black', 'amex_platinum_charge', 'hsbc_taj', 'indusind_pinnacle_world', 'axis_burgundy_private']
const BUREAU_SECTIONS = [
  'general_info', 'loan_details', 'enquiries', 'loan_repayments',
  'loan_patterns', 'borrowing_window', 'institution_details', 'dpd',
] as const

export const TOOL_CASES: ToolCase[] = [
  // ── calculators: pure math, no dependency, so a failure here is unambiguous ────────────────────
  // Expected values computed independently (python, same closed-form formula) before being written here,
  // so these are regression tests on the arithmetic rather than a restatement of whatever the tool said.
  { id: 'emi-1', tool: 'calculateEmi', needs: 'none', input: { principal: 500000, annual_rate: 10.5, tenure_months: 60 },
    expected: 'EMI of exactly 10747 for 500000 at 10.5% over 60 months', check: resultContains('10747') },
  { id: 'emi-2', tool: 'calculateEmi', needs: 'none', input: { principal: 100000, annual_rate: 14, tenure_months: 12 },
    expected: 'EMI of exactly 8979 for a 1 year 14% loan', check: resultContains('8979') },
  { id: 'emi-3', tool: 'calculateEmi', needs: 'none', input: { principal: 2500000, annual_rate: 8.4, tenure_months: 240 },
    expected: 'EMI of exactly 21538 for a 20 year home loan', check: resultContains('21538') },
  // Formatting, not fetching, and separated so the two are never confused: the tool returns "EMI: 10747".
  // Every other money-bearing tool output now goes through inr() (₹ sign, Indian grouping), and the persona
  // requires it of anything the model may repeat, so a bare integer here is an outlier.
  { id: 'emi-fmt', tool: 'calculateEmi', needs: 'none', input: { principal: 30000, annual_rate: 24, tenure_months: 3 },
    expected: 'the EMI formatted as ₹10,403, matching the inr() convention used by the catalog tools',
    check: (r) => { const s = String(r?.result ?? ''); return s.includes('₹') && s.includes('10,403') ? null : `formatted as "${s}", expected ₹ and Indian grouping` } },
  { id: 'emi-5', tool: 'calculateEmi', needs: 'none', input: { principal: 1, annual_rate: 0.1, tenure_months: 1 },
    expected: 'degenerate 1 rupee 1 month loan still produces a figure, no NaN', check: (r) => resultContains('EMI')(r) ?? (String(r?.result).includes('NaN') ? 'NaN in result' : null) },
  { id: 'foir-1', tool: 'calculateFoir', needs: 'none', input: { monthly_obligations: 25000, monthly_income: 100000 },
    expected: 'FOIR 25% with a band', check: resultContains('25') },
  { id: 'foir-2', tool: 'calculateFoir', needs: 'none', input: { monthly_obligations: 60000, monthly_income: 80000 },
    expected: 'FOIR 75%, a stretched band', check: resultContains('75') },
  { id: 'foir-3', tool: 'calculateFoir', needs: 'none', input: { monthly_obligations: 0, monthly_income: 50000 },
    expected: 'zero obligations reads 0%, not a divide error', check: resultContains('0') },
  // Completeness, not fetching. The tool returns "FOIR: 75.0%" and nothing else, while the credit-card
  // addendum talks about affordability BANDING, so the model has to invent the band from the bare number.
  { id: 'foir-band', tool: 'calculateFoir', needs: 'none', input: { monthly_obligations: 45000, monthly_income: 60000 },
    expected: 'the 75% ratio plus an affordability band, so the band is not left to the model',
    check: (r) => { const s = String(r?.result ?? '').toLowerCase(); return /comfort|stretch|high|tight|safe|risk|band/.test(s) ? null : `no affordability band in "${r?.result}"` } },

  // ── eligibility: pure classification over score + income ───────────────────────────────────────
  { id: 'elig-1', tool: 'checkCardEligibility', needs: 'none', input: { cibil_score: 800, monthly_income: 200000 },
    expected: "tier 'premium' with a reason", check: nonNull('tier', 'reason') },
  { id: 'elig-2', tool: 'checkCardEligibility', needs: 'none', input: { cibil_score: 760, monthly_income: 60000 },
    expected: 'a tier and reason for a good-score mid-income user', check: nonNull('tier', 'reason') },
  { id: 'elig-3', tool: 'checkCardEligibility', needs: 'none', input: { cibil_score: 640, monthly_income: 30000 },
    expected: 'a lower tier, still with a stated reason', check: nonNull('tier', 'reason') },
  { id: 'elig-4', tool: 'checkCardEligibility', needs: 'none', input: { cibil_score: 550, monthly_income: 18000 },
    expected: "tier 'secured' for a thin/low score", check: nonNull('tier', 'reason') },
  { id: 'elig-5', tool: 'checkCardEligibility', needs: 'none', input: { cibil_score: 750, monthly_income: 100000 },
    expected: 'the common salaried case resolves to a tier', check: nonNull('tier', 'reason') },

  // ── getCardFees ────────────────────────────────────────────────────────────────────────────────
  ...FEE_CARDS.map((card, i) => ({
    id: `fees-${i + 1}`, tool: 'getCardFees', needs: 'catalog' as Need, input: { card },
    expected: 'joining and annual fee with GST, plus the year-one total and note',
    check: nonNull('card_name', 'joining_fee', 'annual_fee', 'joining_fee_with_gst', 'annual_fee_with_gst', 'first_year_total_with_gst', 'first_year_note'),
  })),
  // The catalog carries a first_year_fee column that says these three cost NOTHING in year one, while
  // joining_fee is 12000 / 20000 / 500. No tool reads that column, so first_year_note quotes the joining
  // fee. Asserted as a FETCH GAP on purpose: this case is expected to fail until the column is wired in.
  { id: 'fees-fyf-1', tool: 'getCardFees', needs: 'catalog', input: { card: 'icici_emeralde' },
    expected: 'first_year_total_with_gst reflects catalog first_year_fee=0, not joining_fee=12000',
    check: (r) => (r?.first_year_total_with_gst === 0 ? null : `year one quoted as ${r?.first_year_total_with_gst}, catalog first_year_fee is 0`) },
  { id: 'fees-fyf-2', tool: 'getCardFees', needs: 'catalog', input: { card: 'icici_times_black' },
    expected: 'first_year_total_with_gst reflects catalog first_year_fee=0, not joining_fee=20000',
    check: (r) => (r?.first_year_total_with_gst === 0 ? null : `year one quoted as ${r?.first_year_total_with_gst}, catalog first_year_fee is 0`) },
  { id: 'fees-fyf-3', tool: 'getCardFees', needs: 'catalog', input: { card: 'rbl_irctc' },
    expected: 'first_year_fee=500 with joining_fee=0, so year one is 500 plus GST',
    check: (r) => (r?.first_year_total_with_gst != null && r.first_year_total_with_gst > 0 ? null : `year one quoted as ${r?.first_year_total_with_gst}, catalog first_year_fee is 500`) },

  // ── getCardCriteria ────────────────────────────────────────────────────────────────────────────
  ...CRITERIA_CARDS.map((cardName, i) => ({
    id: `crit-${i + 1}`, tool: 'getCardCriteria', needs: 'catalog' as Need, input: { cardName },
    expected: 'ok=true with at least one card carrying its approval thresholds',
    check: (r: any) => (r?.ok === false ? `ok=false: ${r?.message}` : Array.isArray(r?.cards) && r.cards.length ? null : `no cards returned: ${String(r?.message).slice(0, 70)}`),
  })),
  { id: 'crit-6', tool: 'getCardCriteria', needs: 'catalog', input: { cardName: 'amex_platinum_charge', employmentType: 'self_employed' },
    expected: 'self-employed floor differs from salaried (208333 vs 125000 in the catalog)',
    check: (r) => (Array.isArray(r?.cards) && r.cards.length ? null : 'no cards for the self_employed variant') },

  // ── getCardDetails ─────────────────────────────────────────────────────────────────────────────
  ...['hdfc_tata_neu_infinity', 'axis_atlas', 'icici_times_black', 'amex_platinum_travel', 'hdfc_pixel_play', 'sbi_simplyclick', 'axis_magnus_burgundy'].map((card, i) => ({
    id: `det-${i + 1}`, tool: 'getCardDetails', needs: 'catalog' as Need, input: { card },
    expected: 'card identity plus the fees / rewards / lounge / fuel sub-objects',
    check: nonNull('card_name', 'issuer_name', 'fees', 'rewards'),
  })),

  // ── getCardBenefits ────────────────────────────────────────────────────────────────────────────
  ...BENEFIT_CARDS.map((card, i) => ({
    id: `ben-${i + 1}`, tool: 'getCardBenefits', needs: 'catalog' as Need, input: { card },
    expected: 'a non-empty benefits array for a card with many benefit rows',
    check: (r: any) => nonNull('card_name', 'benefits')(r) ?? (Array.isArray(r.benefits) && r.benefits.length ? null : 'benefits array is empty'),
  })),
  { id: 'ben-6', tool: 'getCardBenefits', needs: 'catalog', input: { card: 'axis_atlas', benefit_type: 'lounge' },
    expected: 'the verified lounge block, built from the 6 card_lounge rows',
    check: (r) => (Array.isArray(r?.benefits) && r.benefits.some((b: any) => b?.benefit_type === 'lounge') ? null : 'no lounge benefit returned for a card with 6 lounge rows') },
  { id: 'ben-7', tool: 'getCardBenefits', needs: 'catalog', input: { card: 'hdfc_tata_neu_infinity', benefit_type: 'fuel' },
    expected: 'the fuel surcharge waiver block, from fuel_waiver_pct=0.01',
    check: (r) => (Array.isArray(r?.benefits) && r.benefits.some((b: any) => b?.benefit_type === 'fuel') ? null : 'no fuel benefit for a card with fuel_waiver_pct set') },

  // ── getCardPartnerRates, all three modes ───────────────────────────────────────────────────────
  ...RATE_CARDS.map((card, i) => ({
    id: `pr-card-${i + 1}`, tool: 'getCardPartnerRates', needs: 'catalog' as Need, input: { card },
    expected: 'card_all mode with every partner rate on that card', check: rowsAtLeast(4, 'card_all'),
  })),
  ...HOT_PARTNERS.map((partner, i) => ({
    id: `pr-partner-${i + 1}`, tool: 'getCardPartnerRates', needs: 'catalog' as Need, input: { partner },
    expected: 'partner_all reverse lookup with several cards, each named', check: rowsAtLeast(4, 'partner_all'),
  })),
  { id: 'pr-pair-1', tool: 'getCardPartnerRates', needs: 'catalog', input: { card: 'icici_adani_platinum', partner: 'bookmyshow' },
    expected: 'the specific 25% rate with its ₹200 monthly cap',
    check: (r) => rowsAtLeast(1, 'card_partner')(r) ?? (r.rows[0].reward_rate === 0.25 ? null : `rate was ${r.rows[0].reward_rate}, catalog says 0.25`) },
  { id: 'pr-pair-2', tool: 'getCardPartnerRates', needs: 'catalog', input: { card: 'sc_digismart', partner: 'yatra' },
    expected: '25% at Yatra with a ₹4,000 cap', check: rowsAtLeast(1, 'card_partner') },
  { id: 'pr-pair-3', tool: 'getCardPartnerRates', needs: 'catalog', input: { card: 'icici_times_black', partner: 'icici_ishop' },
    expected: 'the iShop rows, which carry rate_variant labels', check: rowsAtLeast(1, 'card_partner') },
  { id: 'pr-spend-1', tool: 'getCardPartnerRates', needs: 'catalog', input: { card: 'idfc_first_millennia', partner: 'zomato', monthly_spend: 15000 },
    expected: 'computed block with monthly_value, annual_value and a math_note',
    check: (r) => rowsAtLeast(1, 'card_partner')(r) ?? (r.rows[0].computed?.math_note ? null : 'computed/math_note absent when monthly_spend was passed') },
  { id: 'pr-spend-2', tool: 'getCardPartnerRates', needs: 'catalog', input: { partner: 'swiggy', monthly_spend: 8000 },
    expected: 'reverse lookup ranked by what the user would actually earn',
    check: (r) => rowsAtLeast(2, 'partner_all')(r) ?? (r.rows.some((x: any) => x.computed) ? null : 'no computed block on any row') },
  { id: 'pr-cat-1', tool: 'getCardPartnerRates', needs: 'catalog', input: { card: 'hdfc_swiggy', partner: 'swiggy', monthly_spend: 15000 },
    expected: 'category fallback: 10% online_food rate, capped 1500, labelled category_rate',
    check: (r) => rowsAtLeast(1)(r) ?? (r.rows[0].source ? null : 'row has no source label') },
  { id: 'pr-cat-2', tool: 'getCardPartnerRates', needs: 'catalog', input: { card: 'hdfc_swiggy_orange', partner: 'swiggy', monthly_spend: 15000 },
    expected: 'the 5% / ₹1,500 category rate the model previously invented as ₹750',
    check: (r) => rowsAtLeast(1)(r) ?? (r.rows[0].reward_cap_value_month === 1500 ? null : `cap was ${r.rows[0].reward_cap_value_month}, catalog says 1500`) },

  // ── compareCards ───────────────────────────────────────────────────────────────────────────────
  ...([
    ['hsbc_taj', 'amex_platinum_charge'],
    ['axis_atlas', 'hdfc_tata_neu_infinity'],
    ['sbi_simplyclick', 'amex_smartearn'],
    ['icici_times_black', 'axis_reserve', 'axis_burgundy_private'],
    ['hdfc_pixel_play', 'hdfc_phonepe_uno'],
  ] as string[][]).map((cards, i) => ({
    id: `cmp-${i + 1}`, tool: 'compareCards', needs: 'catalog' as Need, input: { cards },
    expected: `one result entry per card (${cards.length})`,
    check: (r: any) => noErr(r) ?? (Array.isArray(r?.results) && r.results.length === cards.length ? null : `${r?.results?.length} results for ${cards.length} cards`),
  })),

  // ── getCardFullProfile ─────────────────────────────────────────────────────────────────────────
  ...['icici_times_black', 'axis_atlas', 'amex_platinum_travel', 'hsbc_taj', 'hdfc_tata_neu_infinity'].map((card, i) => ({
    id: `full-${i + 1}`, tool: 'getCardFullProfile', needs: 'catalog' as Need, input: { card },
    expected: 'the merged profile: identity, fees, rewards and benefits in one payload',
    check: nonNull('card_name', 'fees', 'rewards'),
  })),

  // ── user-scoped: signals ───────────────────────────────────────────────────────────────────────
  { id: 'sig-all', tool: 'getSignals', needs: 'user', input: {},
    expected: 'available=true with the full signals payload', check: availableWith() },
  { id: 'sig-tier1', tool: 'getSignals', needs: 'user', input: { section: 'tier1' },
    expected: 'the tier1 base-variable section', check: sectionPresent('tier1') },
  { id: 'sig-tier2', tool: 'getSignals', needs: 'user', input: { section: 'tier2' },
    expected: 'the tier2 derived section', check: sectionPresent('tier2') },
  { id: 'sig-compose', tool: 'getSignals', needs: 'user', input: { section: 'compose' },
    expected: 'the compose section that drives the reply', check: sectionPresent('compose') },

  // ── user-scoped: bureau, one case per valid section ────────────────────────────────────────────
  ...BUREAU_SECTIONS.map((section) => ({
    id: `bureau-${section}`, tool: 'getBureauDetail', needs: 'user' as Need, input: { section },
    expected: `the '${section}' section, populated`, check: sectionPresent(section),
  })),
  { id: 'bureau-profile', tool: 'getBureauProfile', needs: 'user', input: {},
    expected: 'the PII-stripped full profile', check: (r) => (r && Object.keys(r).length > 2 ? null : `thin payload: ${Object.keys(r ?? {}).length} keys`) },

  // ── user-scoped: statement ─────────────────────────────────────────────────────────────────────
  // No statement has ever been uploaded for TEST_MOBILE, so these report NODATA, not FAIL: the tool
  // correctly returns available=false with a reason, which is the behaviour we want when there is nothing
  // to read. They stay in the suite so the day a statement exists, the fetch path gets exercised.
  { id: 'stmt-list', tool: 'getStatement', needs: 'user', input: {},
    expected: 'available=true with the chunk headings listed', check: availableWith(),
    nodataWhen: (r) => r?.available === false },
  { id: 'stmt-query', tool: 'getStatement', needs: 'user', input: { query: 'closing balance' },
    expected: 'search mode returning matching chunks', check: availableWith('mode'),
    nodataWhen: (r) => r?.available === false },
  { id: 'stmt-emi', tool: 'getStatement', needs: 'user', input: { query: 'EMI' },
    expected: 'search mode finding EMI lines', check: availableWith('mode'),
    nodataWhen: (r) => r?.available === false },

  // ── exa web grounding ──────────────────────────────────────────────────────────────────────────
  { id: 'exa-1', tool: 'exaSearch', needs: 'exa', input: { query: 'HDFC Infinia annual fee 2026', num_results: 3 },
    expected: 'at least one result with a url', check: (r) => (Array.isArray(r?.results) && r.results.length ? null : `no results: ${JSON.stringify(r).slice(0, 80)}`) },
  { id: 'exa-2', tool: 'exaSearch', needs: 'exa', input: { query: 'Axis Atlas devaluation news', num_results: 3, category: 'news' },
    expected: 'news-category results', check: (r) => (Array.isArray(r?.results) && r.results.length ? null : 'no results for the news category') },
  { id: 'exa-3', tool: 'exaSearch', needs: 'exa', input: { query: 'RBI credit card billing cycle rules', num_results: 5 },
    expected: 'regulatory search returns 5 results', check: (r) => (Array.isArray(r?.results) && r.results.length >= 2 ? null : 'fewer than 2 results') },
  { id: 'exa-4', tool: 'exaSearch', needs: 'exa', input: { query: 'ICICI Emeralde Private first year fee waiver', num_results: 3 },
    expected: 'the query behind the first_year_fee gap returns something to verify against', check: (r) => (Array.isArray(r?.results) && r.results.length ? null : 'no results') },

  // ── not-found and edge paths: must fail cleanly, never fabricate ───────────────────────────────
  { id: 'neg-fees', tool: 'getCardFees', needs: 'catalog', input: { card: 'zzz_not_a_real_card' },
    expected: 'a clean not-found that points at exaSearch, no invented fees', check: cleanNotFound },
  { id: 'neg-details', tool: 'getCardDetails', needs: 'catalog', input: { card: 'zzz_not_a_real_card' },
    expected: 'clean not-found', check: cleanNotFound },
  { id: 'neg-benefits', tool: 'getCardBenefits', needs: 'catalog', input: { card: 'zzz_not_a_real_card' },
    expected: 'clean not-found', check: cleanNotFound },
  { id: 'neg-criteria', tool: 'getCardCriteria', needs: 'catalog', input: { cardName: 'zzz_not_a_real_card' },
    expected: 'ok=false or an empty card list, stated', check: (r) => (r?.ok === false || (Array.isArray(r?.cards) && r.cards.length === 0) ? null : 'claimed to find a nonexistent card') },
  { id: 'neg-full', tool: 'getCardFullProfile', needs: 'catalog', input: { card: 'zzz_not_a_real_card' },
    expected: 'clean not-found', check: cleanNotFound },
  { id: 'neg-pr-args', tool: 'getCardPartnerRates', needs: 'catalog', input: {},
    expected: "an 'at least one' argument error, not a silent empty result",
    check: (r) => (typeof r?.error === 'string' && r.error.length ? null : 'no error when neither card nor partner was given') },
  { id: 'neg-pr-pair', tool: 'getCardPartnerRates', needs: 'catalog', input: { card: 'amex_platinum_charge', partner: 'irctc' },
    expected: 'no_data_note for a pairing with neither a merchant nor a category rate',
    check: (r) => (r?.rows?.length ? null : r?.no_data_note ? null : 'zero rows AND no no_data_note, which is the silence the model fills from memory') },
  { id: 'neg-cmp-unknown', tool: 'compareCards', needs: 'catalog', input: { cards: ['zzz_not_real', 'yyy_not_real'] },
    expected: 'states both are unknown rather than comparing invented cards',
    check: (r) => (r?.error != null || (Array.isArray(r?.results) && r.results.every((x: any) => x?.found === false || x?.error)) ? null : 'compared two nonexistent cards without saying so') },
  { id: 'neg-ambig', tool: 'getCardFees', needs: 'catalog', input: { card: 'platinum' },
    expected: 'a partial name matching many cards resolves to one AND flags the alternatives',
    check: (r) => (r?.found === false ? 'found=false for a partial name that matches many cards' : Array.isArray(r?.other_matches) && r.other_matches.length ? null : 'no other_matches for an ambiguous partial name') },
  // A SECURITY invariant, not a not-found case. resolveUserId is context-first by design, so a user_id in
  // the tool arguments must NOT override the server-verified one: otherwise a prompt-injected argument
  // would read another user's bureau signals. This asserts the arg is ignored, which is what the first
  // version of this case mistook for a bug.
  { id: 'sig-arg-ignored', tool: 'getSignals', needs: 'user', input: { user_id: '9999999999' },
    expected: "the request context's user wins; a user_id passed as an argument is ignored, not honoured",
    check: (r) => (r?.available === true ? null : `context user_id was not used: ${JSON.stringify(r).slice(0, 90)}`) },
  { id: 'neg-emi-tiny', tool: 'calculateEmi', needs: 'none', input: { principal: 1000, annual_rate: 36, tenure_months: 1 },
    expected: 'a one-month high-rate loan still yields a finite EMI',
    check: (r) => resultContains('EMI')(r) ?? (/NaN|Infinity/.test(String(r?.result)) ? 'non-finite figure in result' : null) },
  { id: 'neg-foir-high', tool: 'calculateFoir', needs: 'none', input: { monthly_obligations: 120000, monthly_income: 100000 },
    expected: 'obligations above income reads over 100%, stated not clamped silently',
    check: resultContains('120') },
]
