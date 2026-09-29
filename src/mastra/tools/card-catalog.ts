import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getCatalogPool, CATALOG_DB_UNAVAILABLE } from '../lib/catalog-db'
import { cardMatchSql, resolveCardCandidates, editionAmbiguity } from '../lib/catalog-cards'
import { tracer } from '../lib/otel'

/**
 * Card catalog READ tools, ported from Cred (agent/src/mastra/tools/*) to Credix conventions:
 *   - createTool + zod, fail-soft returns ({ ok:false, message }), never throw on an expected miss.
 *   - PII-safe span (counts/outcomes only). Card data is public product info, not PII.
 *   - Dropped from the Cred originals: makeProgress/writer.custom (playground-only), the embedded
 *     card-web-fallback (Credix's exaSearch is a separate tool the agent calls on a miss), and
 *     toModelOutput (the agent narrates the structured result under the Rahul persona).
 */

// pg returns `numeric`/`decimal` columns as strings (to preserve precision); integers come as
// numbers. toNum coerces either to a JS number (or null) so z.number() output schemas hold.
const toNum = (v: string | number | null | undefined): number | null =>
  v == null ? null : typeof v === 'number' ? v : parseFloat(v)

type CriteriaRow = {
  name: string
  issuer_name: string
  tier: string | null
  annual_fee: number | null
  income_floor_monthly: number | null
  score_floor: number | null
  ntc_ok: boolean | null
  invite_only: boolean | null
  fx_markup_pct: number | null
  interest_free_days_max: number | null
  accepting_new_applications: boolean
}

// Log the real DB error server-side and return a generic message. pg error strings can carry
// hostnames, TLS/auth, or connection details, so they must never reach the model (or, via the model,
// the user). Keeps the fail-soft contract while preserving diagnostics in the server log.
function dbErrorMessage(err: unknown): string {
  console.error('[card-catalog] DB error:', err instanceof Error ? err.message : String(err))
  return 'The card catalog is temporarily unavailable, please try again shortly.'
}

// getCardCriteria — a card's eligibility thresholds. Uses the shared cardMatchSql token matcher (so
// "Axis Atlas" matches "Axis Bank Atlas Credit Card", same as the other card tools; a contiguous
// LIKE missed multi-word names with intervening words, live-caught 2026-07-13). Numeric columns are
// cast to float8 so pg returns JS numbers (numeric columns otherwise arrive as strings and would
// fail the outputSchema). employmentType selects the income-floor column and rides as the LAST param
// after cardMatchSql's own ($1 raw, $2..$(n+1) tokens, fuzzy). Ported from Cred get-card-criteria.ts.
export const getCardCriteria = createTool({
  id: 'getCardCriteria',
  description:
    "Look up a credit card's eligibility criteria from the catalog: income floor, minimum credit " +
    'score, new-to-credit (NTC) policy, annual fee, forex markup, interest-free days, and invite-only ' +
    'status. Use when assessing whether a user qualifies for a specific named card. A card may return ' +
    'accepting_new_applications=false (grandfathered: existing holders keep benefits, no new ' +
    'applications) — if so, tell the user plainly and never imply they can apply. Returns ' +
    '{ ok: false } when the catalog is unavailable or no card matches; on no match, verify with ' +
    'exaSearch rather than guessing.',
  inputSchema: z.object({
    cardName: z
      .string()
      .describe("Card name or partial name to search, e.g. 'HDFC Regalia', 'Axis Atlas', 'Kotak'."),
    employmentType: z
      .enum(['salaried', 'self_employed'])
      .optional()
      .describe("User's employment type — selects the correct income-floor column. Pass if known."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    message: z.string().optional(),
    cards: z
      .array(
        z.object({
          name: z.string(),
          issuer_name: z.string(),
          tier: z.string().nullable(),
          annual_fee: z.number().nullable(),
          income_floor_monthly: z.number().nullable(),
          score_floor: z.number().nullable(),
          ntc_ok: z.boolean().nullable(),
          invite_only: z.boolean().nullable(),
          fx_markup_pct: z.number().nullable(),
          interest_free_days_max: z.number().nullable(),
          accepting_new_applications: z.boolean(),
        }),
      )
      .optional(),
  }),
  execute: async (inputData) => {
    const { cardName, employmentType } = inputData
    return tracer.startActiveSpan('catalog.criteria', async (span) => {
      try {
        const pool = getCatalogPool()
        if (!pool) {
          span.setAttribute('app.catalog.available', false)
          return { ok: false, message: CATALOG_DB_UNAVAILABLE }
        }
        const m = cardMatchSql(cardName)
        const empIdx = m.params.length + 1
        const { rows } = await pool.query(
          `SELECT name, issuer_name, tier,
                  annual_fee::float8 AS annual_fee,
                  (CASE $${empIdx}
                      WHEN 'salaried'      THEN income_floor_monthly_salaried
                      WHEN 'self_employed' THEN income_floor_monthly_selfemployed
                      ELSE LEAST(
                             COALESCE(income_floor_monthly_salaried, income_floor_monthly_selfemployed),
                             COALESCE(income_floor_monthly_selfemployed, income_floor_monthly_salaried))
                   END)::float8 AS income_floor_monthly,
                  score_floor::float8 AS score_floor,
                  ntc_ok, invite_only,
                  fx_markup_pct::float8 AS fx_markup_pct,
                  interest_free_days_max,
                  COALESCE(accepting_new_applications, true) AS accepting_new_applications
             FROM catalog.card
            WHERE (${m.where}) AND is_active IS NOT FALSE
            ORDER BY ${m.order}
            LIMIT 5`,
          [...m.params, employmentType ?? null],
        )
        span.setAttribute('app.catalog.available', true)
        span.setAttribute('app.catalog.match_count', rows.length)
        if (rows.length === 0) {
          return {
            ok: false,
            message: `No active card found matching "${cardName}". Try a partial name like "Regalia" or "Atlas", or verify with exaSearch.`,
          }
        }
        return { ok: true, cards: rows as CriteriaRow[] }
      } catch (err) {
        span.setAttribute('app.catalog.error', true)
        return { ok: false, message: dbErrorMessage(err) }
      } finally {
        span.end()
      }
    })
  },
})

// getCardFees — full fee breakdown for one card. Ported from Cred card-fees.ts. Numeric (pct) columns
// come back from pg as strings, so they are parseFloat'd; integer columns (fees, waivers) stay raw.
const GST = 0.18

/** Rupees for any string the model may repeat to the user: ₹ sign, Indian grouping, digits only, as the
 *  persona requires. Rounded because a fee with GST is rarely whole and a reply must not show paise.
 *  Module level on purpose: this file had three copies of it, two of which rounded differently. */
export const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

/**
 * The year-one sentence the model quotes to the user, built from the GST-inclusive figures.
 *
 * PURELY user-facing: it carries no instruction to the model. The rule it enforces, that year one is
 * the joining fee alone and the two fees are never summed, lives in CREDIT_CARD_ADDENDUM, because a
 * "Do NOT" inside this string was liable to be read out verbatim (PR #20 review).
 */
export function firstYearNote(joiningWithGst: number | null, annualWithGst: number | null): string | null {
  if (joiningWithGst == null && annualWithGst == null) return null
  if (joiningWithGst == null) {
    return `No joining fee is published, so year one is the annual fee of ${inr(annualWithGst!)} with GST.`
  }
  const renewal =
    annualWithGst != null
      ? `The annual fee of ${inr(annualWithGst)} with GST applies from renewal in year 2.`
      : 'No separate annual fee is published for year one.'
  return `Year one costs ${inr(joiningWithGst)}, which is the joining fee with GST. ${renewal}`
}

export const getCardFees = createTool({
  id: 'getCardFees',
  description:
    'Fetch the full fee breakdown for a credit card from the catalog: joining fee, annual fee, ' +
    'add-on fee, GST-inclusive totals, waiver thresholds, forex markup, DCC, interest ' +
    '(monthly/APR), interest-free days, cash advance charges, minimum amount due, and late payment. ' +
    "Use for 'what is the annual fee', 'forex markup', 'interest rate', 'cash advance charges', 'is " +
    "the fee waived'. Call BEFORE exaSearch — these are verified in the catalog; on a miss, verify " +
    'with exaSearch rather than guessing.',
  inputSchema: z.object({
    card: z.string().describe("Card ID (e.g. 'hdfc_infinia') or partial name (e.g. 'HDFC Infinia')."),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    card_id: z.string(),
    card_name: z.string(),
    issuer: z.string(),
    joining_fee: z.number().nullable(),
    joining_fee_waiver_spend: z.number().nullable(),
    annual_fee: z.number().nullable(),
    annual_fee_waiver_spend: z.number().nullable(),
    addon_fee: z.number().nullable(),
    joining_fee_with_gst: z.number().nullable(),
    annual_fee_with_gst: z.number().nullable(),
    fx_markup_pct: z.number().nullable(),
    dcc_pct: z.number().nullable(),
    interest_monthly_pct: z.number().nullable(),
    interest_apr_pct: z.number().nullable(),
    interest_free_days_max: z.number().nullable(),
    mad_pct: z.number().nullable(),
    mad_min: z.number().nullable(),
    emi_conversion_fee_pct: z.number().nullable(),
    no_cost_emi_note: z.string().nullable(),
    cash_advance_available: z.boolean().nullable(),
    cash_advance_pct: z.number().nullable(),
    cash_advance_min: z.number().nullable(),
    late_payment_slabs: z.unknown(),
    misc_fees: z.unknown(),
    notes: z.string().nullable(),
    // Year-one composition, computed here rather than left to the model. The 2026-08-04 battery asked
    // "total first year cost of HDFC Infinia including GST" and got ₹29,500, joining plus annual added
    // together, when year one is the joining fee alone. right-card's F1 was the identical wrong answer
    // on the identical card family, so this is a known model failure, not a one-off slip. The rule ships
    // WITH the numbers because a rule in a prompt can be skipped and a field in a tool result cannot.
    first_year_total_with_gst: z.number().nullable(),
    first_year_note: z.string().nullable(),
    other_matches: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    ambiguous_with: z.array(z.string()).default([]),
    error: z.string().nullable(),
  }),
  execute: async (inputData) => {
    const { card } = inputData
    const notFound = {
      found: false as const,
      card_id: '',
      card_name: '',
      issuer: '',
      joining_fee: null,
      joining_fee_waiver_spend: null,
      annual_fee: null,
      annual_fee_waiver_spend: null,
      addon_fee: null,
      joining_fee_with_gst: null,
      annual_fee_with_gst: null,
      fx_markup_pct: null,
      dcc_pct: null,
      interest_monthly_pct: null,
      interest_apr_pct: null,
      interest_free_days_max: null,
      mad_pct: null,
      mad_min: null,
      emi_conversion_fee_pct: null,
      no_cost_emi_note: null,
      cash_advance_available: null,
      cash_advance_pct: null,
      cash_advance_min: null,
      late_payment_slabs: null,
      misc_fees: null,
      notes: null,
      first_year_total_with_gst: null,
      first_year_note: null,
      other_matches: [] as { id: string; name: string }[],
      ambiguous_with: [] as string[],
      error: null as string | null,
    }
    return tracer.startActiveSpan('catalog.fees', async (span) => {
      try {
        const pool = getCatalogPool()
        if (!pool) {
          span.setAttribute('app.catalog.available', false)
          return { ...notFound, error: CATALOG_DB_UNAVAILABLE }
        }
        span.setAttribute('app.catalog.available', true)
        const m = cardMatchSql(card)
        const res = await pool.query<{
          id: string
          name: string
          issuer_name: string
          joining_fee: number | null
          joining_fee_waiver_spend: number | null
          annual_fee: number | null
          annual_fee_waiver_spend: number | null
          addon_fee: number | null
          fx_markup_pct: string | null
          dcc_pct: string | null
          interest_monthly_pct: string | null
          interest_apr_pct: string | null
          interest_free_days_max: number | null
          mad_pct: string | null
          mad_min: number | null
          emi_conversion_fee_pct: string | null
          no_cost_emi_note: string | null
          cash_advance_available: boolean
          cash_advance_pct: string | null
          cash_advance_min: number | null
          late_payment_slabs: unknown
          misc_fees: unknown
          notes: string | null
        }>(
          `SELECT id, name, issuer_name,
                  joining_fee, joining_fee_waiver_spend, annual_fee, annual_fee_waiver_spend, addon_fee,
                  fx_markup_pct, dcc_pct,
                  interest_monthly_pct, interest_apr_pct, interest_free_days_max,
                  mad_pct, mad_min, emi_conversion_fee_pct, no_cost_emi_note,
                  cash_advance_available, cash_advance_pct, cash_advance_min,
                  late_payment_slabs, misc_fees, notes
             FROM catalog.card
            WHERE ${m.where}
            ORDER BY ${m.order} LIMIT 1`,
          m.params,
        )
        span.setAttribute('app.catalog.found', res.rows.length > 0)
        if (!res.rows.length) {
          return {
            ...notFound,
            card_name: card,
            error: `Card '${card}' not found in catalog. Verify with exaSearch rather than guessing.`,
          }
        }
        const c = res.rows[0]
        const otherMatches = (await resolveCardCandidates(card, 6)).filter((x) => x.id !== c.id)
        const ambiguousWith = editionAmbiguity(card, c.name, otherMatches)
        const jf = c.joining_fee
        const af = c.annual_fee
        // GST-inclusive figures computed once, then reused by the fields and the note below.
        const jfGst = jf != null ? Math.round(jf * (1 + GST)) : null
        const afGst = af != null ? Math.round(af * (1 + GST)) : null
        return {
          found: true,
          card_id: c.id,
          card_name: c.name,
          issuer: c.issuer_name,
          joining_fee: jf,
          joining_fee_waiver_spend: c.joining_fee_waiver_spend,
          annual_fee: af,
          annual_fee_waiver_spend: c.annual_fee_waiver_spend,
          addon_fee: c.addon_fee,
          joining_fee_with_gst: jfGst,
          annual_fee_with_gst: afGst,
          // Year one is the JOINING fee only; the annual fee starts at renewal. Never the sum.
          first_year_total_with_gst: jfGst ?? afGst,
          first_year_note: firstYearNote(jfGst, afGst),
          fx_markup_pct: c.fx_markup_pct != null ? parseFloat(c.fx_markup_pct) : null,
          dcc_pct: c.dcc_pct != null ? parseFloat(c.dcc_pct) : null,
          interest_monthly_pct: c.interest_monthly_pct != null ? parseFloat(c.interest_monthly_pct) : null,
          interest_apr_pct: c.interest_apr_pct != null ? parseFloat(c.interest_apr_pct) : null,
          interest_free_days_max: c.interest_free_days_max,
          mad_pct: c.mad_pct != null ? parseFloat(c.mad_pct) : null,
          mad_min: c.mad_min,
          emi_conversion_fee_pct: c.emi_conversion_fee_pct != null ? parseFloat(c.emi_conversion_fee_pct) : null,
          no_cost_emi_note: c.no_cost_emi_note,
          cash_advance_available: c.cash_advance_available,
          cash_advance_pct: c.cash_advance_pct != null ? parseFloat(c.cash_advance_pct) : null,
          cash_advance_min: c.cash_advance_min,
          late_payment_slabs: c.late_payment_slabs,
          misc_fees: c.misc_fees,
          notes: c.notes,
          other_matches: otherMatches,
          ambiguous_with: ambiguousWith,
          error: null,
        }
      } catch (err) {
        span.setAttribute('app.catalog.error', true)
        return { ...notFound, card_name: card, error: dbErrorMessage(err) }
      } finally {
        span.end()
      }
    })
  },
})

// getCardPartnerRates — merchant/brand-specific earn rates, or the reverse lookup of which cards earn
// best at a merchant. Ported from Cred card-partner-rates.ts. reward_rate is numeric (string) -> parseFloat.
const partnerRateRow = z.object({
  card_id: z.string(),
  card_name: z.string(),
  partner_code: z.string(),
  reward_rate: z.number().nullable(),
  reward_cap_value_month: z.number().nullable(),
  reward_cap_spend_month: z.number().nullable(),
  is_instant_discount: z.boolean().nullable(),
  note: z.string().nullable(),
  // Columns the catalog has always held and this tool used to drop on the floor. Each one changes the
  // real answer, so a merchant drill-down that omits them is confidently wrong:
  //   rate_variant           some cards carry 3 rates for ONE merchant (icici_times_black at iShop is
  //                          12% flights / 12% vouchers / 24% hotels). Without the label the rows look
  //                          identical apart from the number and the model just picks one.
  //   applicable_days        ISO day numbers, 1 = Monday. Axis Horizon's 10% on Swiggy is days=[3],
  //                          Wednesdays only. Dropping this turned a weekly offer into an everyday rate.
  //   min_transaction_value  spend below it earns nothing at all.
  //   channel_gated          only through the issuer's own portal or app, not at the merchant.
  //   shared_cap_group       the monthly cap is shared with other merchants, so per merchant maths
  //                          double counts the same ceiling.
  //   override_reward_currency  the reward is miles or a program currency, not rupees back.
  //   earn_quantum_*         points accrue per block (2 points per ₹150), so real earn rounds DOWN per
  //                          transaction and is not spend x rate.
  // Provenance. A category rate is NOT a merchant-specific offer and must not be presented as one.
  // Verified 2026-08-05: neither Swiggy card has a card_partner_rate row for swiggy, the real 5% with a
  // ₹1,500 cap lives in card_category under online_food, and with the merchant lookup returning nothing
  // the model filled the gap from memory and stated a ₹750 cap that does not exist.
  source: z.enum(['partner_rate', 'category_rate']),
  category_code: z.string().nullable(),
  rewards_excluded: z.boolean().nullable(),
  rate_variant: z.string().nullable(),
  applicable_days: z.array(z.number()).nullable(),
  applicable_days_label: z.string().nullable(),
  min_transaction_value: z.number().nullable(),
  channel_gated: z.boolean().nullable(),
  shared_cap_group: z.string().nullable(),
  override_reward_currency: z.string().nullable(),
  earn_quantum_points: z.number().nullable(),
  earn_quantum_amount: z.number().nullable(),
  // Computed here, not left to the model, for the same reason getCardFees now returns first_year_note:
  // arithmetic in prose is where wrong money answers come from. Present only when monthly_spend is given.
  computed: z
    .object({
      monthly_spend: z.number(),
      earning_spend: z.number(),
      monthly_value: z.number(),
      annual_value: z.number(),
      binding_cap: z.enum(['value_cap', 'spend_cap', 'none']),
      spend_headroom: z.number().nullable(),
      is_upper_bound: z.boolean(),
      math_note: z.string(),
    })
    .nullable(),
})

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
/**
 * ISO-8601 day numbers (1 = Monday) to a label, or null when there is no restriction worth stating.
 * Corroborated against the catalog's own free-text notes: the days=[3] rows all read "Wednesdays only".
 *
 * All seven weekdays is NOT a restriction, so it returns null. It used to return "every day", and that
 * truthy string made mapPartnerRow treat the row as conditional: is_upper_bound set, demoted below
 * genuinely dependable rows by rankByValue, and a "treat this as a ceiling, not a monthly expectation"
 * caveat appended to an offer that runs daily. A card that enumerates all 7 days ranked worse than an
 * identical one that left the column null (PR #20 review).
 *
 * Deduped, because [3,3,3,3,3,3,3] is seven entries and one day. Out-of-range codes are still surfaced as
 * "day N" rather than dropped: an unrecognised value may be a real restriction, and silently ignoring it
 * would overstate the offer, which is the direction that costs a user money.
 */
function dayLabel(days: number[] | null): string | null {
  if (!days || !days.length) return null
  const uniq = [...new Set(days)].sort((a, b) => a - b)
  if (uniq.length === 7 && uniq.every((d) => d >= 1 && d <= 7)) return null
  // `||` not `??`: DAY_NAMES[0] is the empty-string placeholder, which would render as " only".
  return `${uniq.map((d) => DAY_NAMES[d] || `day ${d}`).join(' and ')} only`
}

type RawPartnerRow = {
  partner_code: string
  reward_rate: string | null
  reward_cap_value_month: number | null
  reward_cap_spend_month: number | null
  is_instant_discount: boolean | null
  note: string | null
  rate_variant: string | null
  applicable_days: number[] | null
  min_transaction_value: number | null
  channel_gated: boolean | null
  shared_cap_group: string | null
  override_reward_currency: string | null
  earn_quantum_points: string | null
  earn_quantum_amount: string | null
  // Only set by the category fallback below.
  source?: 'partner_rate' | 'category_rate'
  category_code?: string | null
  rewards_excluded?: boolean | null
}

/** Every column this tool exposes, in one place so the three query modes cannot drift apart. */
const PARTNER_RATE_COLS =
  'partner_code, reward_rate, reward_cap_value_month, reward_cap_spend_month, is_instant_discount, note, ' +
  'rate_variant, applicable_days, min_transaction_value, channel_gated, shared_cap_group, ' +
  'override_reward_currency, earn_quantum_points, earn_quantum_amount'

/**
 * Turn a catalog row into the tool's row, and when the user's monthly spend at this merchant is known,
 * do the arithmetic here rather than in the reply. The order matters: the spend cap limits how much
 * spend earns at all, THEN the value cap limits what that spend pays out.
 */
export function mapPartnerRow(
  cardId: string,
  cardName: string,
  r: RawPartnerRow,
  monthlySpend?: number,
): z.infer<typeof partnerRateRow> {
  const rate = r.reward_rate != null ? parseFloat(r.reward_rate) : null
  const quantumPoints = r.earn_quantum_points != null ? parseFloat(r.earn_quantum_points) : null
  const quantumAmount = r.earn_quantum_amount != null ? parseFloat(r.earn_quantum_amount) : null
  const daysLabel = dayLabel(r.applicable_days)

  let computed: z.infer<typeof partnerRateRow>['computed'] = null
  if (monthlySpend != null && monthlySpend > 0 && rate != null) {
    // Whole rupees from here on. The schema accepts any positive number, and everything downstream rounds
    // (inr() for the prose, Math.round for the fields), so a decimal input made computed.monthly_spend
    // disagree with the ₹ figure printed in math_note. Rounded rather than rejected at the boundary: the
    // model passing 15000.5 should get a usable answer, not a failed tool call (PR #20 review).
    const spend = Math.round(monthlySpend)
    const earningSpend = r.reward_cap_spend_month != null ? Math.min(spend, r.reward_cap_spend_month) : spend
    const gross = earningSpend * rate
    const monthlyValue = r.reward_cap_value_month != null ? Math.min(gross, r.reward_cap_value_month) : gross
    const bindingCap: 'value_cap' | 'spend_cap' | 'none' =
      r.reward_cap_value_month != null && gross > r.reward_cap_value_month
        ? 'value_cap'
        : r.reward_cap_spend_month != null && spend > r.reward_cap_spend_month
          ? 'spend_cap'
          : 'none'
    // How much of their spend is earning nothing. Only meaningful when a cap actually binds.
    const headroom =
      bindingCap === 'spend_cap' && r.reward_cap_spend_month != null
        ? spend - r.reward_cap_spend_month
        : bindingCap === 'value_cap' && r.reward_cap_value_month != null
          ? Math.max(0, spend - r.reward_cap_value_month / rate)
          : null
    // An upper bound rather than an expected figure when the offer only runs on certain days, when the
    // payout is a program currency whose rupee value depends on redemption, or when points round down per
    // block.
    //
    // ONE predicate for per-block accrual, used by both the flag and the note below. They disagreed
    // before: the flag fired on earn_quantum_amount alone while the note needed both halves, so a row
    // carrying an amount with no points count was demoted by rankByValue and said nothing about why
    // (PR #20 review). Kept firing on the amount alone rather than requiring both, because a block size
    // means the real earn rounds DOWN, and losing that signal makes the row look more dependable than it
    // is. The note degrades instead, stating the rounding without inventing a points figure.
    const perBlockEarn = quantumAmount != null
    const isUpperBound = Boolean(daysLabel) || Boolean(r.override_reward_currency) || perBlockEarn

    // Number(toFixed(2)) rather than a `% 1 === 0` test, matching how the fuel waiver pct is formatted
    // lower down. Floating point makes 8 of the 100 two-decimal rates fail that test: 0.07 * 100 is
    // 7.000000000000001 and 0.29 * 100 is 28.999999999999996, so plausible reward rates printed as
    // "7.00%" and "29.00%" in user-facing text. toFixed(2) rounds, Number drops the trailing zeros, so a
    // whole percent reads "7%" and a real fraction still reads "2.5%" (PR #20 review).
    const pct = Number((rate * 100).toFixed(2))
    const parts: string[] = []
    parts.push(
      `At ${inr(spend)} a month, ${pct}% earns ${inr(monthlyValue)} a month and ${inr(monthlyValue * 12)} a year.`,
    )
    if (bindingCap === 'value_cap') parts.push(`The monthly cap of ${inr(r.reward_cap_value_month!)} is what limits it.`)
    if (bindingCap === 'spend_cap') parts.push(`Only the first ${inr(r.reward_cap_spend_month!)} of monthly spend earns.`)
    if (headroom != null && headroom > 0) parts.push(`About ${inr(headroom)} of that spend earns nothing extra.`)
    if (r.min_transaction_value != null) parts.push(`Transactions under ${inr(r.min_transaction_value)} do not qualify.`)
    if (daysLabel) parts.push(`Applies ${daysLabel}, so treat this as a ceiling, not a monthly expectation.`)
    if (r.is_instant_discount) parts.push('This is a discount at checkout, not reward points, so it does not accumulate.')
    if (r.channel_gated) parts.push('Only through the issuer\'s own portal or app, not directly at the merchant.')
    if (r.shared_cap_group) parts.push('The cap is shared with other merchants, so the real ceiling may be lower.')
    // Phrased as an estimate, not a denial. reward_rate is value-back per rupee (see the getCardDetails
    // description), so the ₹ figures above ARE the rupee estimate; saying "paid in points, not rupees"
    // contradicted the numbers in the same note and the tool's own contract (PR #20 review).
    if (r.override_reward_currency) {
      parts.push(
        `This earns ${r.override_reward_currency} rather than cashback, so treat the rupee figures above as an estimate that depends on how you redeem.`,
      )
    }
    if (perBlockEarn) {
      parts.push(
        quantumPoints != null
          ? `Points accrue ${quantumPoints} per ${inr(quantumAmount!)}, rounded down per transaction.`
          : `Points accrue per ${inr(quantumAmount!)} block, rounded down per transaction, so the real earn is a little lower.`,
      )
    }
    if (r.source === 'category_rate') {
      // Factual, no directive: math_note is quoted to the user, so "so say it that way" was an
      // instruction to the model sitting in user-facing text. Same defect as first_year_note carried.
      parts.push(
        `This is the card's rate for the whole ${r.category_code ?? 'category'} category, not a deal negotiated with this merchant.`,
      )
    }
    if (r.rewards_excluded) parts.push('This category earns NO rewards on this card.')
    computed = {
      monthly_spend: spend,
      earning_spend: Math.round(earningSpend),
      monthly_value: Math.round(monthlyValue),
      annual_value: Math.round(monthlyValue * 12),
      binding_cap: bindingCap,
      spend_headroom: headroom != null ? Math.round(headroom) : null,
      is_upper_bound: isUpperBound,
      math_note: parts.join(' '),
    }
  }

  return {
    card_id: cardId,
    card_name: cardName,
    partner_code: r.partner_code,
    source: r.source ?? 'partner_rate',
    category_code: r.category_code ?? null,
    rewards_excluded: r.rewards_excluded ?? null,
    reward_rate: rate,
    reward_cap_value_month: r.reward_cap_value_month ?? null,
    reward_cap_spend_month: r.reward_cap_spend_month ?? null,
    is_instant_discount: r.is_instant_discount ?? null,
    note: r.note ?? null,
    // `?? null` throughout: a row that predates a column, or a driver that omits it, yields undefined,
    // and the nullable output schema accepts null but not undefined.
    rate_variant: r.rate_variant ?? null,
    applicable_days: r.applicable_days ?? null,
    applicable_days_label: daysLabel,
    min_transaction_value: r.min_transaction_value ?? null,
    channel_gated: r.channel_gated ?? null,
    shared_cap_group: r.shared_cap_group ?? null,
    override_reward_currency: r.override_reward_currency ?? null,
    earn_quantum_points: quantumPoints,
    earn_quantum_amount: quantumAmount,
    computed,
  }
}

/**
 * When a merchant has no negotiated rate for this card, the answer is usually still in the catalog one
 * level up: catalog.partner maps a merchant to a spend category (swiggy -> online_food, and 43 of 61
 * partners carry one), and card_category holds the card's rate for that category.
 *
 * This exists because of a measured failure, not a hunch. On 2026-08-05 a live turn asked for the best
 * card for Swiggy: this tool returned zero rows for the Swiggy ORNGE card, and the reply then stated
 * "5% back, capped at ₹750 per month" out of the model's own memory. The 5% happened to match the real
 * online_food rate; the ₹750 cap was invented, the true cap is ₹1,500, and a user planning to spend more
 * would have been given a ceiling that does not exist.
 */
async function categoryFallback(
  pool: NonNullable<ReturnType<typeof getCatalogPool>>,
  cardId: string,
  cardName: string,
  partnerQuery: string,
  monthlySpend?: number,
): Promise<z.infer<typeof partnerRateRow>[]> {
  const cat = await pool.query<{ code: string; category_code: string | null }>(
    `SELECT code, category_code FROM catalog.partner
      WHERE (code ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%') AND category_code IS NOT NULL
      LIMIT 1`,
    [partnerQuery],
  )
  const categoryCode = cat.rows[0]?.category_code
  if (!categoryCode) return []
  const rows = await pool.query<{
    reward_rate: string | null
    reward_cap_value_month: number | null
    reward_cap_spend_month: number | null
    note: string | null
    min_txn_amount: number | null
    channel_gated: boolean | null
    shared_cap_group: string | null
    override_reward_currency: string | null
    earn_quantum_points: string | null
    earn_quantum_amount: string | null
    rewards_excluded: boolean | null
  }>(
    `SELECT reward_rate, reward_cap_value_month, reward_cap_spend_month, note, min_txn_amount,
            channel_gated, shared_cap_group, override_reward_currency, earn_quantum_points,
            earn_quantum_amount, rewards_excluded
       FROM catalog.card_category WHERE card_id = $1 AND category_code = $2 LIMIT 1`,
    [cardId, categoryCode],
  )
  if (!rows.rows.length) return []
  const r = rows.rows[0]!
  return [
    mapPartnerRow(
      cardId,
      cardName,
      {
        partner_code: cat.rows[0]!.code,
        reward_rate: r.reward_rate,
        reward_cap_value_month: r.reward_cap_value_month,
        reward_cap_spend_month: r.reward_cap_spend_month,
        is_instant_discount: false,
        note: r.note,
        rate_variant: null,
        applicable_days: null,
        min_transaction_value: r.min_txn_amount,
        channel_gated: r.channel_gated,
        shared_cap_group: r.shared_cap_group,
        override_reward_currency: r.override_reward_currency,
        earn_quantum_points: r.earn_quantum_points,
        earn_quantum_amount: r.earn_quantum_amount,
        source: 'category_rate',
        category_code: categoryCode,
        rewards_excluded: r.rewards_excluded,
      },
      monthlySpend,
    ),
  ]
}

/**
 * Rank by what the user would actually earn, when that is known, in two tiers.
 *
 * Tier matters more than the number. A recurring reward you get every day is not comparable to a
 * Wednesday only discount at the till, even when the second one shows a bigger ceiling. Ranking purely
 * on value put five Wednesday instant discounts (a ₹18,000 ceiling) above a real ₹6,000 a year reward,
 * which answers "what is the biggest number" rather than "which card should I actually use". So:
 * dependable rows first, ranked by value, then the conditional ones, also ranked by value.
 *
 * `is_upper_bound` already covers day restrictions, program currencies and per block rounding, so this
 * only has to add the instant discount test.
 */
function rankByValue(rows: z.infer<typeof partnerRateRow>[]): z.infer<typeof partnerRateRow>[] {
  if (!rows.some((r) => r.computed)) return rows
  const conditional = (r: z.infer<typeof partnerRateRow>) =>
    r.is_instant_discount === true || r.computed?.is_upper_bound === true ? 1 : 0
  return [...rows].sort(
    (a, b) => conditional(a) - conditional(b) || (b.computed?.annual_value ?? -1) - (a.computed?.annual_value ?? -1),
  )
}

export const getCardPartnerRates = createTool({
  id: 'getCardPartnerRates',
  description:
    'Fetch partner/merchant-specific earn rates from the catalog (Amazon, Flipkart, Swiggy, Zomato, ' +
    'Myntra, IRCTC, BookMyShow, etc.). Three modes: card only -> all partner rates for that card; ' +
    'partner only -> top cards across the catalog for that merchant (reverse lookup); card + partner ' +
    "-> the specific rate. is_instant_discount=true is a point-of-sale price cut, NOT recurring reward " +
    'points. Pass monthly_spend to get the real earn computed for you in `computed` (caps, minimum ' +
    'transaction value, shared caps and day restrictions applied) with the working in `math_note`; do not ' +
    'do the arithmetic yourself. Each row also carries rate_variant (which of several rates for the same ' +
    'merchant this is), applicable_days_label, channel_gated and override_reward_currency, all of which ' +
    'change the answer. Call BEFORE exaSearch, rates are verified in the catalog.',
  inputSchema: z.object({
    card: z.string().optional().describe("Card ID or partial name. If omitted, partner is required."),
    partner: z
      .string()
      .optional()
      .describe("Partner code or merchant name (e.g. 'amazon', 'swiggy', 'irctc'). If omitted, card is required."),
    monthly_spend: z
      .number()
      .positive()
      .optional()
      .describe(
        'The user\'s monthly spend at ONE named merchant in rupees, when known. Only meaningful when ' +
          'partner is also set: it is ignored in card-only mode, where the rows span every merchant on the ' +
          'card and this figure would not apply to them. Pass it and the tool returns the real earn in ' +
          '`computed`, with caps, minimum transaction values and day restrictions already applied, plus a ' +
          '`math_note` stating the working. Quote those instead of multiplying yourself.',
      ),
  }),
  outputSchema: z.object({
    mode: z.enum(['card_all', 'partner_all', 'card_partner']),
    rows: z.array(partnerRateRow),
    // Present when the catalog genuinely has nothing for this pairing. Says so in words the model can
    // repeat, because silence is what it fills from memory (verified 2026-08-05). Purely factual: the
    // "do not state a rate you did not get" rule lives in CREDIT_CARD_ADDENDUM, because this string is
    // quoted to the user and a directive in it can be read out verbatim.
    no_data_note: z.string().nullable().default(null),
    other_matches: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    error: z.string().nullable(),
  }),
  execute: async (inputData) => {
    const { card, partner, monthly_spend } = inputData
    type Row = z.infer<typeof partnerRateRow>
    const err = (mode: 'card_all' | 'partner_all' | 'card_partner', msg: string) => ({
      mode,
      rows: [] as Row[],
      no_data_note: null,
      other_matches: [] as { id: string; name: string }[],
      error: msg,
    })
    // Mode mirrors the REQUEST shape so error returns (DB down / exception) stay honest instead of
    // always reporting 'card_all'. Derived once from inputs so the catch block can read it too.
    const reqMode = card && partner ? 'card_partner' : partner ? 'partner_all' : 'card_all'
    return tracer.startActiveSpan('catalog.partner_rates', async (span) => {
      try {
        // Validate inputs before the DB check, so a bad request returns the input error even when the
        // catalog is unavailable.
        if (!card && !partner) return err('card_all', 'Provide at least one of card or partner.')
        const pool = getCatalogPool()
        if (!pool) {
          span.setAttribute('app.catalog.available', false)
          return err(reqMode, CATALOG_DB_UNAVAILABLE)
        }
        span.setAttribute('app.catalog.available', true)

        if (card && partner) {
          const m = cardMatchSql(card)
          const cardRes = await pool.query<{ id: string; name: string }>(
            `SELECT id, name FROM catalog.card WHERE ${m.where} ORDER BY ${m.order} LIMIT 1`,
            m.params,
          )
          if (!cardRes.rows.length) return err('card_partner', `Card '${card}' not found. Verify with exaSearch.`)
          const c = cardRes.rows[0]
          const rateRes = await pool.query<RawPartnerRow>(
            `SELECT ${PARTNER_RATE_COLS}
               FROM catalog.card_partner_rate
              WHERE card_id = $1 AND partner_code ILIKE '%' || $2 || '%'
              ORDER BY reward_rate DESC NULLS LAST`,
            [c.id, partner],
          )
          span.setAttribute('app.catalog.match_count', rateRes.rows.length)
          // No negotiated rate for this merchant does NOT mean no answer: fall back to the card's rate
          // for the merchant's category, labelled as such. Without this the model invents one.
          const partnerRows = rateRes.rows.length
            ? rateRes.rows.map((r) => mapPartnerRow(c.id, c.name, r, monthly_spend))
            : await categoryFallback(pool, c.id, c.name, partner, monthly_spend)
          span.setAttribute('app.catalog.source', partnerRows[0]?.source ?? 'none')
          return {
            mode: 'card_partner' as const,
            rows: partnerRows,
            no_data_note: partnerRows.length
              ? null
              : `No merchant rate and no category rate is published for ${c.name} at '${partner}', so there is no verified earn rate, cap or value for this pairing.`,
            other_matches: (await resolveCardCandidates(card, 6)).filter((x) => x.id !== c.id),
            error: null,
          }
        }

        if (card) {
          const m = cardMatchSql(card)
          const cardRes = await pool.query<{ id: string; name: string }>(
            `SELECT id, name FROM catalog.card WHERE ${m.where} ORDER BY ${m.order} LIMIT 1`,
            m.params,
          )
          if (!cardRes.rows.length) return err('card_all', `Card '${card}' not found. Verify with exaSearch.`)
          const c = cardRes.rows[0]
          const rateRes = await pool.query<RawPartnerRow>(
            `SELECT ${PARTNER_RATE_COLS}
               FROM catalog.card_partner_rate WHERE card_id = $1
              ORDER BY reward_rate DESC NULLS LAST
              LIMIT 50`,
            [c.id],
          )
          span.setAttribute('app.catalog.match_count', rateRes.rows.length)
          return {
            mode: 'card_all' as const,
            // monthly_spend is deliberately NOT applied here. It means spend at ONE merchant, and this
            // mode returns every partner on the card, so passing it computed a full earn for Amazon,
            // IRCTC and BookMyShow alike off a figure the user gave for Swiggy: up to 50 fabricated money
            // answers from one real number. The other two modes have a single merchant fixed, so the
            // arithmetic is meaningful there (PR #20 review).
            rows: rateRes.rows.map((r) => mapPartnerRow(c.id, c.name, r)),
            no_data_note: null,
            other_matches: (await resolveCardCandidates(card, 6)).filter((x) => x.id !== c.id),
            error: null,
          }
        }

        // partner-only reverse lookup
        const rateRes = await pool.query<RawPartnerRow & { card_id: string; card_name: string }>(
          `SELECT cpr.card_id, c.name AS card_name, ${PARTNER_RATE_COLS.split(', ').map((col) => `cpr.${col}`).join(', ')}
             FROM catalog.card_partner_rate cpr
             JOIN catalog.card c ON c.id = cpr.card_id
            WHERE cpr.partner_code ILIKE '%' || $1 || '%'
            ORDER BY COALESCE(cpr.is_instant_discount, false) ASC, cpr.reward_rate DESC NULLS LAST
            LIMIT 15`,
          [partner!],
        )
        span.setAttribute('app.catalog.match_count', rateRes.rows.length)
        return {
          mode: 'partner_all' as const,
          // SQL orders by rate, which is the wrong ranking once caps bind: a 10% rate capped at ₹100 a
          // month loses to an uncapped 2% rate for anyone spending real money. When the user's spend is
          // known we can rank by what they would actually earn, so re-sort on the computed annual value
          // and leave the rate ordering alone when it is not.
          rows: rankByValue(rateRes.rows.map((r) => mapPartnerRow(r.card_id, r.card_name, r, monthly_spend))),
          no_data_note: null,
          other_matches: [],
          error: null,
        }
      } catch (e) {
        span.setAttribute('app.catalog.error', true)
        return err(reqMode, dbErrorMessage(e))
      } finally {
        span.end()
      }
    })
  },
})

// getCardBenefits — structured benefits for one card, augmented with canonical lounge (card_lounge),
// fuel-waiver (card columns), and network-tier (network_tier_benefit) data. Ported from Cred
// card-benefits.ts. value_inr / fuel_waiver_pct are numeric (string) -> parseFloat.
const benefitRow = z.object({
  benefit_type: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  value_inr: z.number().nullable(),
  sort_order: z.number(),
  // recurrence: 'monthly' => value_inr is PER MONTH (annualize x12), 'quarterly' x4, 'once' one-time,
  // null/'annual'/'yearly' per year. Do NOT sum across recurrences without normalizing.
  recurrence: z.string().nullable().optional(),
  milestone_period: z.string().nullable().optional(),
})
type BenefitRow = z.infer<typeof benefitRow>

export const getCardBenefits = createTool({
  id: 'getCardBenefits',
  description:
    'Fetch all structured benefits for a credit card from the catalog: lounge access (visits, guest ' +
    'passes, spend gates), welcome/joining gifts, milestone vouchers, golf, dining, insurance covers, ' +
    'fuel surcharge waiver, subscriptions/movies, and network-tier privileges (Visa Infinite / World ' +
    'Elite / Diners Black / RuPay Select). Insurance covers are protection LIMITS, not earnable value ' +
    '— never add them to a benefit-value total. For points redemption / transfer partners use ' +
    'getCardDetails. Call BEFORE exaSearch.',
  inputSchema: z.object({
    card: z.string().describe("Card ID (e.g. 'hdfc_infinia') or partial name."),
    benefit_type: z
      .string()
      .optional()
      .describe('Optional filter: lounge | welcome | milestone | golf | dining | subscription | lifestyle | movie | insurance_benefit | travel | fuel | redemption | concierge. Omit for all.'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    card_id: z.string(),
    card_name: z.string(),
    benefits: z.array(benefitRow),
    grouped: z.record(z.string(), z.array(benefitRow)),
    notes: z.string().nullable(),
    other_matches: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    ambiguous_with: z.array(z.string()).default([]),
    error: z.string().nullable(),
  }),
  execute: async (inputData) => {
    const { card, benefit_type } = inputData
    const empty = {
      found: false as const,
      card_id: '',
      card_name: '',
      benefits: [] as BenefitRow[],
      grouped: {} as Record<string, BenefitRow[]>,
      notes: null as string | null,
      other_matches: [] as { id: string; name: string }[],
      ambiguous_with: [] as string[],
      error: null as string | null,
    }
    return tracer.startActiveSpan('catalog.benefits', async (span) => {
      try {
        const pool = getCatalogPool()
        if (!pool) {
          span.setAttribute('app.catalog.available', false)
          return { ...empty, error: CATALOG_DB_UNAVAILABLE }
        }
        span.setAttribute('app.catalog.available', true)
        const m = cardMatchSql(card)
        const cardRes = await pool.query<{
          id: string
          name: string
          network_tier: string | null
          fuel_waiver_pct: string | null
          fuel_waiver_txn_min: number | null
          fuel_waiver_txn_max: number | null
          fuel_waiver_annual_cap: number | null
          notes: string | null
        }>(
          `SELECT id, name, network_tier, fuel_waiver_pct, fuel_waiver_txn_min, fuel_waiver_txn_max, fuel_waiver_annual_cap, notes
             FROM catalog.card
            WHERE ${m.where}
            ORDER BY ${m.order} LIMIT 1`,
          m.params,
        )
        span.setAttribute('app.catalog.found', cardRes.rows.length > 0)
        if (!cardRes.rows.length) {
          return { ...empty, card_name: card, error: `Card '${card}' not found in catalog. Verify with exaSearch.` }
        }
        const c = cardRes.rows[0]
        const otherMatches = (await resolveCardCandidates(card, 6)).filter((x) => x.id !== c.id)
        const ambiguousWith = editionAmbiguity(card, c.name, otherMatches)

        // Only apply a REAL benefit_type filter — the model has passed made-up values like "all",
        // which matched zero rows. An unrecognized value means "no filter".
        const VALID_BENEFIT_TYPES = new Set([
          'lounge', 'welcome', 'milestone', 'golf', 'dining', 'subscription', 'lifestyle',
          'movie', 'insurance_benefit', 'travel', 'fuel', 'redemption', 'concierge',
        ])
        const typeFilter = benefit_type && VALID_BENEFIT_TYPES.has(benefit_type) ? benefit_type : undefined
        const params: unknown[] = [c.id]
        let typeClause = ''
        if (typeFilter) {
          params.push(typeFilter)
          typeClause = ' AND benefit_type = $2'
        }

        const benRes = await pool.query<{
          benefit_type: string
          title: string
          description: string | null
          value_inr: string | null
          sort_order: number
          recurrence: string | null
          milestone_period: string | null
        }>(
          `SELECT benefit_type, title, description, value_inr, sort_order, recurrence, milestone_period
             FROM catalog.card_benefit
            WHERE card_id = $1${typeClause}
            ORDER BY sort_order, benefit_type, title`,
          params,
        )

        let benefits: BenefitRow[] = benRes.rows.map((r) => ({
          benefit_type: r.benefit_type,
          title: r.title,
          description: r.description,
          value_inr: r.value_inr != null ? parseFloat(r.value_inr) : null,
          sort_order: r.sort_order,
          recurrence: r.recurrence,
          milestone_period: r.milestone_period,
        }))

        // Augment with structured lounge data (card_benefit 'lounge' rows are text-only; card_lounge
        // has visit counts, gates, periods).
        const wantsLounge = !typeFilter || typeFilter === 'lounge'
        if (wantsLounge) {
          const lRes = await pool.query<{
            network: string | null
            lounge_type: string
            visits_per_period: number | null
            period: string
            guest_passes: number
            spend_required: number | null
            access_mechanism: string | null
            tier: string | null
            spend_requirement_period: string | null
          }>(
            `SELECT network, lounge_type, visits_per_period, period, guest_passes, spend_required,
                    access_mechanism, tier, spend_requirement_period
               FROM catalog.card_lounge WHERE card_id = $1 ORDER BY lounge_type, tier NULLS FIRST, network`,
            [c.id],
          )
          if (lRes.rows.length) {
            benefits = benefits.filter((b) => b.benefit_type !== 'lounge')
            const dom = lRes.rows.filter((r) => r.lounge_type === 'domestic')
            const intl = lRes.rows.filter((r) => r.lounge_type === 'international')
            const rail = lRes.rows.filter((r) => r.lounge_type === 'railway')
            const periodLabel = (p: string | null, fallback: string) =>
              p === 'trailing_3_months'
                ? 'in the last 3 months'
                : p === 'trailing_6_months'
                  ? 'in the last 6 months'
                  : p === 'annual'
                    ? 'per year'
                    : p === 'lifetime'
                      ? '(one-time)'
                      : `/${fallback}`
            const fmtRows = (rows: typeof lRes.rows) =>
              rows
                .map((r) => {
                  const tier = r.tier ? `${r.tier} tier: ` : ''
                  const visits = r.visits_per_period == null ? 'Unlimited' : `${r.visits_per_period} visits/${r.period}`
                  const guests = r.guest_passes > 0 ? ` + ${r.guest_passes} guest pass${r.guest_passes > 1 ? 'es' : ''}` : ''
                  const via = r.network ? ` via ${r.network}` : ''
                  const mech = r.access_mechanism === 'milestone_voucher' ? ' [milestone voucher, not direct swipe]' : ''
                  const gate = r.spend_required
                    ? ` (requires ${inr(r.spend_required)} spend ${periodLabel(r.spend_requirement_period, r.period)})`
                    : ''
                  return `${tier}${visits}${via}${guests}${mech}${gate}`
                })
                .join('; ')
            const parts: string[] = []
            if (dom.length) parts.push(`Domestic: ${fmtRows(dom)}`)
            if (intl.length) parts.push(`International: ${fmtRows(intl)}`)
            if (rail.length) parts.push(`Railway: ${fmtRows(rail)}`)
            benefits.unshift({
              benefit_type: 'lounge',
              title: 'Lounge Access (verified)',
              description: parts.join(' | '),
              value_inr: null,
              sort_order: -1,
              recurrence: null,
              milestone_period: null,
            })
          }
        }

        // Fuel surcharge waiver lives in catalog.card columns (canonical, feeds ranking SQL).
        const wantsFuel = !typeFilter || typeFilter === 'fuel'
        if (wantsFuel && c.fuel_waiver_pct != null) {
          const pct = Number((parseFloat(c.fuel_waiver_pct) * 100).toFixed(2))
          const parts = [`${pct}% fuel surcharge waived`]
          if (c.fuel_waiver_txn_min != null && c.fuel_waiver_txn_max != null) {
            // "to", not an en dash: the persona bans dashes as punctuation and TTS reads them badly.
            parts.push(`on transactions ${inr(c.fuel_waiver_txn_min)} to ${inr(c.fuel_waiver_txn_max)}`)
          } else if (c.fuel_waiver_txn_max != null) {
            parts.push(`on transactions up to ${inr(c.fuel_waiver_txn_max)}`)
          } else if (c.fuel_waiver_txn_min != null) {
            parts.push(`on transactions above ${inr(c.fuel_waiver_txn_min)}`)
          }
          if (c.fuel_waiver_annual_cap != null) parts.push(`capped at ${inr(c.fuel_waiver_annual_cap)}/year`)
          benefits.push({
            benefit_type: 'fuel',
            title: 'Fuel Surcharge Waiver (verified)',
            description: parts.join(', '),
            value_inr: null,
            sort_order: -1,
            recurrence: null,
            milestone_period: null,
          })
        }

        // Network-tier privileges live in catalog.network_tier_benefit, keyed by card.network_tier.
        if (c.network_tier) {
          const tRes = await pool.query<{
            benefit_type: string
            title: string
            description: string | null
            value_inr: number | null
          }>(
            `SELECT benefit_type, title, description, value_inr
               FROM catalog.network_tier_benefit WHERE network_tier = $1
              ORDER BY sort_order, title`,
            [c.network_tier],
          )
          // A card-specific benefit is more authoritative than the generic network-tier perk, so skip
          // a tier row that overlaps one the card already lists (else the same benefit appears twice).
          const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
          const existingTitles = benefits.map((b) => normTitle(b.title)).filter(Boolean)
          const overlapsExisting = (t: string) =>
            existingTitles.some((e) => e === t || (t.length >= 6 && e.includes(t)) || (e.length >= 6 && t.includes(e)))
          for (const r of tRes.rows) {
            if (typeFilter && r.benefit_type !== typeFilter) continue
            if (overlapsExisting(normTitle(r.title))) continue
            benefits.push({
              benefit_type: r.benefit_type,
              title: `${r.title} — ${c.network_tier} tier`,
              description: r.description,
              value_inr: r.value_inr,
              sort_order: 100,
              recurrence: null,
              milestone_period: null,
            })
          }
        }

        const grouped: Record<string, BenefitRow[]> = {}
        for (const b of benefits) {
          if (!grouped[b.benefit_type]) grouped[b.benefit_type] = []
          grouped[b.benefit_type].push(b)
        }
        span.setAttribute('app.catalog.match_count', benefits.length)

        return {
          found: true,
          card_id: c.id,
          card_name: c.name,
          benefits,
          grouped,
          notes: c.notes,
          other_matches: otherMatches,
          ambiguous_with: ambiguousWith,
          error: null,
        }
      } catch (err) {
        span.setAttribute('app.catalog.error', true)
        return { ...empty, card_name: card, error: dbErrorMessage(err) }
      } finally {
        span.end()
      }
    })
  },
})

// getCardDetails — PRIMARY card fact aggregator: one card row + 5 parallel reads (per-category earn
// rates, base-tier lounge, milestone/golf benefits, transfer partners, transfer caps). Ported from
// Cred get-card-details.ts. Insurance/dining/welcome detail lives in getCardBenefits, not here.
const detailEarnRate = z.object({
  category_code: z.string(),
  category_display: z.string(),
  reward_rate: z.number().nullable(),
  rewards_excluded: z.boolean(),
  note: z.string().nullable(),
})

// Shared output shape for one card's core facts. Named (not inline) so getCardFullProfile can compose
// it via .omit().extend() instead of redeclaring the schema.
const cardDetailsOutput = z.object({
  found: z.boolean(),
  card_id: z.string(),
  card_name: z.string(),
  issuer_name: z.string(),
  network: z.string().nullable(),
  tier: z.string().nullable(),
  co_brand_partner: z.string().nullable(),
  fees: z.object({
    joining_fee: z.number().nullable(),
    annual_fee: z.number().nullable(),
    joining_fee_waiver_spend: z.number().nullable(),
    annual_fee_waiver_spend: z.number().nullable(),
    addon_fee: z.number().nullable(),
    fx_markup_pct: z.number().nullable(),
    dcc_pct: z.number().nullable(),
  }),
  rewards: z.object({
    reward_currency: z.string().nullable(),
    reward_program_name: z.string().nullable(),
    point_value_paisa: z.number().nullable(),
    points_validity_months: z.number().nullable(),
    earn_rates: z.array(detailEarnRate),
    redemption_options: z.array(z.unknown()),
    milestones: z
      .array(
        z
          .object({
            title: z.string().optional(),
            trigger_spend: z.number().optional(),
            benefit_type: z.string().optional(),
            benefit_value_inr: z.number().optional(),
            milestone_period: z.string().optional(),
            recurrence: z.string().optional(),
            note: z.string().optional(),
          })
          .passthrough(),
      ),
    transfer_partners: z.array(
      z.object({
        program_name: z.string(),
        program_type: z.string(),
        points_in: z.number(),
        miles_out: z.number(),
        note: z.string().nullable(),
      }),
    ),
    transfer_annual_cap_total: z.number().nullable(),
    transfer_caps: z
      .array(z.object({ partner_group: z.string().nullable(), cap_value: z.number().nullable(), cap_period: z.string().nullable() }))
      .default([]),
    points_forfeiture_conditions: z.unknown().nullable(),
  }),
  lounge: z.object({
    domestic_unlimited: z.boolean(),
    intl_unlimited: z.boolean(),
    domestic_visits_year: z.number().nullable(),
    intl_visits_year: z.number().nullable(),
    rows: z.array(
      z.object({
        network: z.string().nullable(),
        lounge_type: z.string(),
        visits_per_period: z.number().nullable(),
        period: z.string(),
        guest_passes: z.number(),
        spend_required: z.number().nullable(),
        spend_requirement_period: z.string().nullable(),
      }),
    ),
  }),
  fuel: z.object({
    waiver_pct: z.number().nullable(),
    txn_min_inr: z.number().nullable(),
    txn_max_inr: z.number().nullable(),
    annual_cap_inr: z.number().nullable(),
  }),
  eligibility: z.object({
    income_floor_salaried: z.number().nullable(),
    income_floor_selfemployed: z.number().nullable(),
    score_floor: z.number().nullable(),
    invite_only: z.boolean().nullable(),
    ntc_ok: z.boolean().nullable(),
  }),
  insurance: z.object({ _note: z.string() }),
  other: z.object({
    golf_benefits: z.unknown(),
    no_cost_emi_available: z.boolean().nullable(),
    addon_free_count: z.number().nullable(),
    addon_earns_rewards: z.boolean().nullable(),
  }),
  notes: z.string().nullable(),
  populate_status: z.string().nullable(),
  other_matches: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  ambiguous_with: z.array(z.string()).default([]),
  error: z.string().nullable(),
})

export const getCardDetails = createTool({
  id: 'getCardDetails',
  description:
    'PRIMARY SOURCE OF TRUTH for one card. Call this BEFORE exaSearch or answering from memory for any ' +
    "question about a card's features, fees, earn rates, lounge, milestones, or redemption/transfer " +
    'value. Returns fees, per-category earn rates (reward_rate is value-back per rupee, e.g. 0.01 = ' +
    '1%, NOT points-per-rupee), exclusions, milestones, golf, lounge detail, fuel waiver, points ' +
    'transfer partners (with annual caps), notes, and eligibility. For insurance/dining/welcome/movie ' +
    'benefits use getCardBenefits. A null field on a returned card means it is not published; call ' +
    'exaSearch only if the card is not in the catalog, or to check a suspected recent change.',
  inputSchema: z.object({
    card: z.string().describe("Card ID (e.g. 'amex_platinum_travel') or partial name (e.g. 'HDFC Infinia')."),
  }),
  outputSchema: cardDetailsOutput,
  execute: async (inputData) => {
    const { card } = inputData
    const notFound = {
      found: false as const,
      card_id: '',
      card_name: '',
      issuer_name: '',
      network: null,
      tier: null,
      co_brand_partner: null,
      fees: { joining_fee: null, annual_fee: null, joining_fee_waiver_spend: null, annual_fee_waiver_spend: null, addon_fee: null, fx_markup_pct: null, dcc_pct: null },
      rewards: { reward_currency: null, reward_program_name: null, point_value_paisa: null, points_validity_months: null, earn_rates: [], redemption_options: [], milestones: [], transfer_partners: [], transfer_annual_cap_total: null, transfer_caps: [], points_forfeiture_conditions: null },
      lounge: { domestic_unlimited: false, intl_unlimited: false, domestic_visits_year: null, intl_visits_year: null, rows: [] },
      fuel: { waiver_pct: null, txn_min_inr: null, txn_max_inr: null, annual_cap_inr: null },
      eligibility: { income_floor_salaried: null, income_floor_selfemployed: null, score_floor: null, invite_only: null, ntc_ok: null },
      insurance: { _note: 'Use getCardBenefits for insurance data.' },
      other: { golf_benefits: null, no_cost_emi_available: null, addon_free_count: null, addon_earns_rewards: null },
      notes: null,
      populate_status: null,
      other_matches: [] as { id: string; name: string }[],
      ambiguous_with: [] as string[],
    }
    return tracer.startActiveSpan('catalog.details', async (span) => {
      try {
        const pool = getCatalogPool()
        if (!pool) {
          span.setAttribute('app.catalog.available', false)
          return { ...notFound, error: CATALOG_DB_UNAVAILABLE }
        }
        span.setAttribute('app.catalog.available', true)
        const m = cardMatchSql(card)
        const cardRes = await pool.query<{
          id: string
          name: string
          issuer_name: string
          network: string | null
          tier: string | null
          co_brand_partner: string | null
          joining_fee: number | null
          annual_fee: number | null
          joining_fee_waiver_spend: number | null
          annual_fee_waiver_spend: number | null
          addon_fee: number | null
          fx_markup_pct: string | null
          dcc_pct: string | null
          reward_currency: string | null
          reward_program_name: string | null
          point_value_paisa: string | number | null
          points_validity_months: number | null
          redemption_options: unknown
          fuel_waiver_pct: string | null
          fuel_waiver_txn_min: number | null
          fuel_waiver_txn_max: number | null
          fuel_waiver_annual_cap: number | null
          income_floor_monthly_salaried: number | null
          income_floor_monthly_selfemployed: number | null
          score_floor: number | null
          invite_only: boolean | null
          ntc_ok: boolean | null
          no_cost_emi_available: boolean | null
          notes: string | null
          populate_status: string | null
          transfer_annual_cap_total: string | number | null
          points_forfeiture_conditions: unknown
          addon_free_count: number | null
          addon_earns_rewards: boolean | null
        }>(
          `SELECT id, name, issuer_name, network, tier, co_brand_partner,
                  joining_fee, annual_fee, joining_fee_waiver_spend, annual_fee_waiver_spend,
                  addon_fee, fx_markup_pct, dcc_pct,
                  reward_currency, reward_program_name, point_value_paisa, points_validity_months,
                  redemption_options,
                  fuel_waiver_pct, fuel_waiver_txn_min, fuel_waiver_txn_max, fuel_waiver_annual_cap,
                  income_floor_monthly_salaried, income_floor_monthly_selfemployed,
                  score_floor, invite_only, ntc_ok,
                  no_cost_emi_available, notes, populate_status,
                  transfer_annual_cap_total, points_forfeiture_conditions,
                  addon_free_count, addon_earns_rewards
             FROM catalog.card
            WHERE ${m.where}
            ORDER BY ${m.order} LIMIT 1`,
          m.params,
        )
        span.setAttribute('app.catalog.found', cardRes.rows.length > 0)
        if (!cardRes.rows.length) {
          return { ...notFound, card_name: card, error: `Card '${card}' not found in catalog. Verify with exaSearch rather than guessing.` }
        }
        const c = cardRes.rows[0]
        const otherMatches = (await resolveCardCandidates(card, 6)).filter((x) => x.id !== c.id)
        const ambiguousWith = editionAmbiguity(card, c.name, otherMatches)

        const [ccRes, loungeRes, benefitRes, transferRes, transferCapRes] = await Promise.all([
          pool.query<{ category_code: string; display_name: string; reward_rate: string | null; rewards_excluded: boolean; note: string | null }>(
            `SELECT cc.category_code, sc.display_name, cc.reward_rate, cc.rewards_excluded, cc.note
               FROM catalog.card_category cc
               JOIN catalog.spend_category sc ON sc.code = cc.category_code
              WHERE cc.card_id = $1
              ORDER BY cc.rewards_excluded ASC, cc.reward_rate DESC NULLS LAST`,
            [c.id],
          ),
          pool.query<{ network: string | null; lounge_type: string; visits_per_period: number | null; period: string; guest_passes: number; spend_required: number | null; spend_requirement_period: string | null }>(
            `SELECT network, lounge_type, visits_per_period, period, guest_passes, spend_required, spend_requirement_period
               FROM catalog.card_lounge WHERE card_id = $1 AND (tier IS NULL OR tier NOT IN ('gold','platinum'))
              ORDER BY lounge_type, network`,
            [c.id],
          ),
          pool.query<{ benefit_type: string; title: string; description: string | null; value_inr: string | number | null; milestone_spend: string | number | null; milestone_period: string | null; recurrence: string }>(
            `SELECT benefit_type, title, description, value_inr, milestone_spend, milestone_period, recurrence
               FROM catalog.card_benefit
              WHERE card_id = $1 AND benefit_type IN ('milestone', 'golf')
              ORDER BY benefit_type, milestone_spend NULLS LAST, sort_order`,
            [c.id],
          ),
          pool.query<{ program_name: string; program_type: string; points_in: number; miles_out: number; note: string | null }>(
            `SELECT program_name, program_type, points_in, miles_out, note
               FROM catalog.card_transfer_partner WHERE card_id = $1
              ORDER BY program_type, program_name`,
            [c.id],
          ),
          pool
            .query<{ partner_group: string | null; cap_value: string | number | null; cap_period: string | null }>(
              `SELECT partner_group, cap_value, cap_period FROM catalog.card_transfer_cap WHERE card_id = $1 ORDER BY partner_group`,
              [c.id],
            )
            .catch(() => ({ rows: [] as { partner_group: string | null; cap_value: string | number | null; cap_period: string | null }[] })),
        ])

        const lr = loungeRes.rows
        const toAnnual = (r: { visits_per_period: number | null; period: string }) =>
          r.visits_per_period !== null ? r.visits_per_period * (r.period === 'quarterly' ? 4 : 1) : 0
        const domRows = lr.filter((r) => r.lounge_type === 'domestic')
        const intlRows = lr.filter((r) => r.lounge_type === 'international')
        const domestic_unlimited = domRows.some((r) => r.visits_per_period === null)
        const intl_unlimited = intlRows.some((r) => r.visits_per_period === null)
        span.setAttribute('app.catalog.earn_rate_count', ccRes.rows.length)

        return {
          found: true,
          card_id: c.id,
          card_name: c.name,
          issuer_name: c.issuer_name,
          network: c.network,
          tier: c.tier,
          co_brand_partner: c.co_brand_partner,
          fees: {
            joining_fee: c.joining_fee,
            annual_fee: c.annual_fee,
            joining_fee_waiver_spend: c.joining_fee_waiver_spend,
            annual_fee_waiver_spend: c.annual_fee_waiver_spend,
            addon_fee: c.addon_fee,
            fx_markup_pct: toNum(c.fx_markup_pct),
            dcc_pct: toNum(c.dcc_pct),
          },
          rewards: {
            reward_currency: c.reward_currency,
            reward_program_name: c.reward_program_name,
            point_value_paisa: toNum(c.point_value_paisa),
            points_validity_months: c.points_validity_months,
            earn_rates: ccRes.rows.map((r) => ({
              category_code: r.category_code,
              category_display: r.display_name,
              reward_rate: toNum(r.reward_rate),
              rewards_excluded: r.rewards_excluded,
              note: r.note,
            })),
            redemption_options: Array.isArray(c.redemption_options) ? c.redemption_options : [],
            milestones: benefitRes.rows
              .filter((r) => r.benefit_type === 'milestone')
              .map((r) => ({
                title: r.title,
                trigger_spend: toNum(r.milestone_spend) ?? undefined,
                benefit_value_inr: toNum(r.value_inr) ?? undefined,
                milestone_period: r.milestone_period ?? undefined,
                recurrence: r.recurrence,
                note: r.description ?? undefined,
              })),
            transfer_partners: transferRes.rows,
            transfer_annual_cap_total: toNum(c.transfer_annual_cap_total),
            transfer_caps: transferCapRes.rows.map((r) => ({ partner_group: r.partner_group, cap_value: toNum(r.cap_value), cap_period: r.cap_period })),
            points_forfeiture_conditions: c.points_forfeiture_conditions ?? null,
          },
          lounge: {
            domestic_unlimited,
            intl_unlimited,
            domestic_visits_year: domestic_unlimited || domRows.length === 0 ? null : domRows.reduce((acc, r) => acc + toAnnual(r), 0),
            intl_visits_year: intl_unlimited || intlRows.length === 0 ? null : intlRows.reduce((acc, r) => acc + toAnnual(r), 0),
            rows: lr,
          },
          fuel: {
            waiver_pct: toNum(c.fuel_waiver_pct),
            txn_min_inr: c.fuel_waiver_txn_min,
            txn_max_inr: c.fuel_waiver_txn_max,
            annual_cap_inr: c.fuel_waiver_annual_cap,
          },
          eligibility: {
            income_floor_salaried: c.income_floor_monthly_salaried,
            income_floor_selfemployed: c.income_floor_monthly_selfemployed,
            score_floor: c.score_floor,
            invite_only: c.invite_only,
            ntc_ok: c.ntc_ok,
          },
          insurance: { _note: 'Use getCardBenefits for insurance data.' },
          other: {
            golf_benefits: benefitRes.rows
              .filter((r) => r.benefit_type === 'golf')
              .map((r) => ({ title: r.title, note: r.description, value_inr: toNum(r.value_inr) })),
            no_cost_emi_available: c.no_cost_emi_available,
            addon_free_count: c.addon_free_count,
            addon_earns_rewards: c.addon_earns_rewards,
          },
          notes: c.notes,
          populate_status: c.populate_status,
          other_matches: otherMatches,
          ambiguous_with: ambiguousWith,
          error: null,
        }
      } catch (err) {
        span.setAttribute('app.catalog.error', true)
        return { ...notFound, card_name: card, error: dbErrorMessage(err) }
      } finally {
        span.end()
      }
    })
  },
})

// compareCards — side-by-side of 2-3 cards (fees, top earn rates, welcome/milestone, lounge counts,
// eligibility floors). Ported from Cred card-compare.ts. Each card resolves independently; a missing
// one gets its own error entry without failing the others.
const compareEarnRate = z.object({
  category_code: z.string(),
  display_name: z.string(),
  reward_rate: z.number().nullable(),
  excluded: z.boolean(),
  note: z.string().nullable(),
})

const compareSummary = z.object({
  card_id: z.string(),
  card_name: z.string(),
  issuer: z.string(),
  tier: z.string().nullable(),
  joining_fee: z.number().nullable(),
  annual_fee: z.number().nullable(),
  annual_fee_waiver_spend: z.number().nullable(),
  fx_markup_pct: z.number().nullable(),
  lounge_domestic: z.number().nullable(),
  lounge_domestic_unlimited: z.boolean(),
  lounge_intl: z.number().nullable(),
  lounge_intl_unlimited: z.boolean(),
  lounge_spend_required: z.number().nullable(),
  lounge_spend_period: z.string().nullable(),
  income_floor_salaried: z.number().nullable(),
  income_floor_selfemployed: z.number().nullable(),
  score_floor: z.number().nullable(),
  ntc_ok: z.boolean().nullable(),
  top_earn_rates: z.array(compareEarnRate),
  welcome_benefits: z.array(z.object({ title: z.string(), value_inr: z.number().nullable() })),
  milestone_benefits: z.array(z.object({ title: z.string(), value_inr: z.number().nullable(), description: z.string().nullable(), recurrence: z.string().nullable() })),
  other_matches: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  ambiguous_with: z.array(z.string()).default([]),
  error: z.string().nullable(),
})

export const compareCards = createTool({
  id: 'compareCards',
  description:
    'Side-by-side comparison of 2 to 3 credit cards from the catalog: fees, top earn rates, ' +
    "welcome/milestone benefits, lounge counts, and eligibility floors for each. Use for 'X vs Y', " +
    "'compare A and B', 'which is better'. Call BEFORE exaSearch — one catalog call pulls all of it.",
  inputSchema: z.object({
    cards: z
      .array(z.string())
      .min(2)
      .max(3)
      .describe("2 to 3 card IDs or partial names, e.g. ['HDFC Infinia', 'Axis Atlas']."),
  }),
  outputSchema: z.object({
    results: z.array(compareSummary),
    error: z.string().nullable(),
  }),
  execute: async (inputData) => {
    const { cards } = inputData
    return tracer.startActiveSpan('catalog.compare', async (span) => {
      span.setAttribute('app.catalog.compare_count', cards.length)
      try {
        const pool = getCatalogPool()
        if (!pool) {
          span.setAttribute('app.catalog.available', false)
          return { results: [], error: CATALOG_DB_UNAVAILABLE }
        }
        span.setAttribute('app.catalog.available', true)
        const results = await Promise.all(
          cards.map(async (cardQuery) => {
            const m = cardMatchSql(cardQuery)
            const cardRes = await pool.query<{
              id: string
              name: string
              issuer_name: string
              tier: string | null
              joining_fee: number | null
              annual_fee: number | null
              annual_fee_waiver_spend: number | null
              fx_markup_pct: string | null
              income_floor_monthly_salaried: number | null
              income_floor_monthly_selfemployed: number | null
              score_floor: number | null
              ntc_ok: boolean | null
            }>(
              `SELECT id, name, issuer_name, tier, joining_fee, annual_fee, annual_fee_waiver_spend,
                      fx_markup_pct, income_floor_monthly_salaried,
                      income_floor_monthly_selfemployed, score_floor, ntc_ok
                 FROM catalog.card
                WHERE ${m.where}
                ORDER BY ${m.order} LIMIT 1`,
              m.params,
            )
            const notFound = {
              card_id: '',
              card_name: cardQuery,
              issuer: '',
              tier: null,
              joining_fee: null,
              annual_fee: null,
              annual_fee_waiver_spend: null,
              fx_markup_pct: null,
              lounge_domestic: null,
              lounge_domestic_unlimited: false,
              lounge_intl: null,
              lounge_intl_unlimited: false,
              lounge_spend_required: null,
              lounge_spend_period: null,
              income_floor_salaried: null,
              income_floor_selfemployed: null,
              score_floor: null,
              ntc_ok: null,
              top_earn_rates: [],
              welcome_benefits: [],
              milestone_benefits: [],
              other_matches: [] as { id: string; name: string }[],
              ambiguous_with: [] as string[],
            }
            if (!cardRes.rows.length) {
              return { ...notFound, error: `Card '${cardQuery}' not found. Verify with exaSearch.` }
            }
            const c = cardRes.rows[0]
            const otherMatches = (await resolveCardCandidates(cardQuery, 5)).filter((x) => x.id !== c.id)
            const ambiguousWith = editionAmbiguity(cardQuery, c.name, otherMatches)

            const [ccRes, benRes, loungeRes] = await Promise.all([
              pool.query<{ category_code: string; display_name: string; reward_rate: string | null; rewards_excluded: boolean; note: string | null }>(
                `SELECT cc.category_code, sc.display_name, cc.reward_rate, cc.rewards_excluded, cc.note
                   FROM catalog.card_category cc
                   JOIN catalog.spend_category sc ON sc.code = cc.category_code
                  WHERE cc.card_id = $1
                  ORDER BY cc.rewards_excluded ASC, cc.reward_rate DESC NULLS LAST
                  LIMIT 5`,
                [c.id],
              ),
              pool.query<{ benefit_type: string; title: string; value_inr: string | number | null; description: string | null; recurrence: string | null }>(
                `SELECT benefit_type, title, value_inr, description, recurrence
                   FROM catalog.card_benefit
                  WHERE card_id = $1 AND benefit_type IN ('welcome', 'milestone')
                  ORDER BY sort_order`,
                [c.id],
              ),
              pool.query<{ lounge_type: string; visits_per_period: number | null; period: string; spend_required: number | null; spend_requirement_period: string | null }>(
                `SELECT lounge_type, visits_per_period, period, spend_required, spend_requirement_period
                   FROM catalog.card_lounge WHERE card_id = $1 AND (tier IS NULL OR tier NOT IN ('gold','platinum'))`,
                [c.id],
              ),
            ])

            const toAnnual = (r: { visits_per_period: number | null; period: string }) =>
              r.visits_per_period !== null ? r.visits_per_period * (r.period === 'quarterly' ? 4 : 1) : 0
            const domRows = loungeRes.rows.filter((r) => r.lounge_type === 'domestic')
            const intlRows = loungeRes.rows.filter((r) => r.lounge_type === 'international')
            const lounge_domestic_unlimited = domRows.some((r) => r.visits_per_period === null)
            const intl_unlimited = intlRows.some((r) => r.visits_per_period === null)
            // Pick the LOWEST gate among gated rows, not an arbitrary first (the query has no
            // spend ordering). Mirrors attachLounge() in lib/catalog-cards.ts.
            const gatedRows = loungeRes.rows.filter(
              (r): r is typeof r & { spend_required: number } => r.spend_required != null,
            )
            const gated = gatedRows.length
              ? gatedRows.reduce((min, r) => (r.spend_required < min.spend_required ? r : min))
              : null

            return {
              card_id: c.id,
              card_name: c.name,
              issuer: c.issuer_name,
              tier: c.tier,
              joining_fee: c.joining_fee,
              annual_fee: c.annual_fee,
              annual_fee_waiver_spend: c.annual_fee_waiver_spend,
              fx_markup_pct: toNum(c.fx_markup_pct),
              lounge_domestic_unlimited,
              lounge_domestic: lounge_domestic_unlimited || domRows.length === 0 ? null : domRows.reduce((acc, r) => acc + toAnnual(r), 0),
              lounge_intl_unlimited: intl_unlimited,
              lounge_intl: intl_unlimited || intlRows.length === 0 ? null : intlRows.reduce((acc, r) => acc + toAnnual(r), 0),
              lounge_spend_required: gated?.spend_required ?? null,
              lounge_spend_period: gated?.spend_requirement_period ?? gated?.period ?? null,
              income_floor_salaried: c.income_floor_monthly_salaried,
              income_floor_selfemployed: c.income_floor_monthly_selfemployed,
              score_floor: c.score_floor,
              ntc_ok: c.ntc_ok,
              top_earn_rates: ccRes.rows.map((r) => ({
                category_code: r.category_code,
                display_name: r.display_name,
                reward_rate: toNum(r.reward_rate),
                excluded: r.rewards_excluded,
                note: r.note,
              })),
              welcome_benefits: benRes.rows
                .filter((r) => r.benefit_type === 'welcome')
                .map((r) => ({ title: r.title, value_inr: toNum(r.value_inr) })),
              milestone_benefits: benRes.rows
                .filter((r) => r.benefit_type === 'milestone')
                .map((r) => ({ title: r.title, value_inr: toNum(r.value_inr), description: r.description, recurrence: r.recurrence })),
              other_matches: otherMatches,
              ambiguous_with: ambiguousWith,
              error: null,
            }
          }),
        )
        return { results, error: null }
      } catch (err) {
        span.setAttribute('app.catalog.error', true)
        return { results: [], error: dbErrorMessage(err) }
      } finally {
        span.end()
      }
    })
  },
})

// Composition seam for building one catalog tool out of others. Mastra types Tool.execute loosely
// (its value is optional and its return is widened), so calling it cross-tool in typed code loses the
// result type. This adapter invokes execute once and validates the result through the caller's schema,
// so the value is both runtime checked (a direct .execute call skips Mastra's own output validation)
// and correctly typed. The one unavoidable assertion lives here; callers stay fully typed via z.infer.
async function runCatalogTool<S extends z.ZodTypeAny>(
  tool: { execute?: unknown },
  input: Record<string, unknown>,
  schema: S,
): Promise<z.infer<S>> {
  const execute = tool.execute as ((input: Record<string, unknown>) => Promise<unknown>) | undefined
  if (!execute) throw new Error('catalog tool is missing its execute implementation')
  return schema.parse(await execute(input))
}

// getCardFullProfile — the single "everything about one card" call. Merges getCardDetails +
// getCardBenefits + getCardPartnerRates so the agent gets fees, earn rates, lounge, fuel, milestones,
// transfers, eligibility, structured benefits, and merchant partner rates in ONE tool call. The three
// granular tools stay for narrow questions. Resolution is anchored on getCardDetails (single source of
// truth for fuzzy matching + edition ambiguity); its resolved card_id is fed to the other two so all
// three sections describe the SAME card.
//
// The output reuses cardDetailsOutput, drops its insurance placeholder (real insurance benefits are
// embedded under benefits here), and adds the benefit and partner-rate sections.
const cardFullProfileOutput = cardDetailsOutput.omit({ insurance: true }).extend({
  benefits: z.array(benefitRow),
  benefits_grouped: z.record(z.string(), z.array(benefitRow)),
  partner_rates: z.array(partnerRateRow),
})

// The exact subsets getCardFullProfile consumes from its two sibling tools. Parsing results through
// these (not the tools' full output schemas) keeps the merge honest: it depends only on fields it uses.
// benefitsView keeps found + error; partnerRatesView keeps error only (getCardPartnerRates exposes no
// found), so a sibling that fails soft (empty rows + error) is surfaced, not merged as "no data".
const benefitsView = z.object({
  found: z.boolean(),
  benefits: z.array(benefitRow),
  grouped: z.record(z.string(), z.array(benefitRow)),
  error: z.string().nullable(),
})
const partnerRatesView = z.object({ rows: z.array(partnerRateRow), error: z.string().nullable() })

// Degraded shape for getCardFullProfile's defensive catch: a throw (e.g. a schema-drift parse failure
// in runCatalogTool) must fail soft into an { error } payload like every other catalog tool, not crash
// the tool call. Mirrors getCardDetails' not-found shape (minus insurance) plus this tool's sections.
const emptyCardFullProfile = {
  found: false as const,
  card_id: '', card_name: '', issuer_name: '',
  network: null, tier: null, co_brand_partner: null,
  fees: { joining_fee: null, annual_fee: null, joining_fee_waiver_spend: null, annual_fee_waiver_spend: null, addon_fee: null, fx_markup_pct: null, dcc_pct: null },
  rewards: { reward_currency: null, reward_program_name: null, point_value_paisa: null, points_validity_months: null, earn_rates: [], redemption_options: [], milestones: [], transfer_partners: [], transfer_annual_cap_total: null, transfer_caps: [], points_forfeiture_conditions: null },
  lounge: { domestic_unlimited: false, intl_unlimited: false, domestic_visits_year: null, intl_visits_year: null, rows: [] },
  fuel: { waiver_pct: null, txn_min_inr: null, txn_max_inr: null, annual_cap_inr: null },
  eligibility: { income_floor_salaried: null, income_floor_selfemployed: null, score_floor: null, invite_only: null, ntc_ok: null },
  other: { golf_benefits: null, no_cost_emi_available: null, addon_free_count: null, addon_earns_rewards: null },
  notes: null, populate_status: null,
  other_matches: [] as { id: string; name: string }[], ambiguous_with: [] as string[],
  benefits: [], benefits_grouped: {}, partner_rates: [],
}

export const getCardFullProfile = createTool({
  id: 'getCardFullProfile',
  description:
    'PRIMARY one-shot lookup for a full rundown of ONE card: everything getCardDetails returns (fees, ' +
    'per-category earn rates, lounge, fuel, milestones, transfer partners, eligibility) PLUS structured ' +
    'benefits (welcome/dining/insurance/movie/golf, from getCardBenefits) and merchant partner rates ' +
    '(from getCardPartnerRates). Call this BEFORE exaSearch or memory when the user wants the whole ' +
    'picture of a card. Use the granular tools only for a single narrow aspect. partner_rates is often ' +
    'empty when a card models accelerated rates as category earn rates, which appear under ' +
    'rewards.earn_rates: that is correct, not a miss.',
  inputSchema: z.object({
    card: z.string().describe("Card ID (e.g. 'hdfc_infinia') or partial name (e.g. 'HDFC Infinia')."),
  }),
  outputSchema: cardFullProfileOutput,
  execute: async (inputData) => {
    const { card } = inputData
    return tracer.startActiveSpan('catalog.full_profile', async (span) => {
      try {
        // Anchor on getCardDetails: it does the fuzzy match + edition-ambiguity, and its fail-soft
        // shapes (CATALOG_DB_UNAVAILABLE / not-found) already carry the full detail object. Strip the
        // insurance placeholder; the rest spreads straight through on both the miss and the hit path.
        const details = await runCatalogTool(getCardDetails, { card }, cardDetailsOutput)
        const { insurance: _insurance, ...detail } = details
        if (!details.found) {
          span.setAttribute('app.catalog.found', false)
          return { ...detail, benefits: [], benefits_grouped: {}, partner_rates: [] }
        }
        // Feed the resolved card_id (exact) to the sibling tools so they cannot drift to a different
        // card; run them in parallel since both only need the id.
        const [benefits, partner] = await Promise.all([
          runCatalogTool(getCardBenefits, { card: details.card_id }, benefitsView),
          runCatalogTool(getCardPartnerRates, { card: details.card_id }, partnerRatesView),
        ])
        // A sibling can fail soft (transient DB error) AFTER getCardDetails already succeeded: it
        // returns empty rows plus an error. Surface that as a partial failure so the agent does not read
        // an empty section as "not published" (the card addendum treats null/missing fields that way).
        const sectionErrors = [
          benefits.error ? `benefits (${benefits.error})` : !benefits.found ? 'benefits lookup failed' : null,
          partner.error ? `partner rates (${partner.error})` : null,
        ].filter(Boolean)
        span.setAttribute('app.catalog.found', true)
        span.setAttribute('app.catalog.benefit_count', benefits.benefits.length)
        span.setAttribute('app.catalog.partner_rate_count', partner.rows.length)
        if (sectionErrors.length) span.setAttribute('app.catalog.partial_error', sectionErrors.join('; '))
        return {
          ...detail,
          benefits: benefits.benefits,
          benefits_grouped: benefits.grouped,
          partner_rates: partner.rows,
          // Overrides the null carried in from getCardDetails' success shape when a section failed.
          error: sectionErrors.length
            ? `Partial catalog lookup: ${sectionErrors.join('; ')}. Some sections may be incomplete.`
            : null,
        }
      } catch (err) {
        // Match the sibling catalog tools: an unexpected throw (e.g. a schema-drift parse failure in
        // runCatalogTool) degrades to an { error } payload, not a hard tool crash that loses the turn.
        span.setAttribute('app.catalog.found', false)
        return { ...emptyCardFullProfile, error: `Catalog lookup failed: ${dbErrorMessage(err)}` }
      } finally {
        span.end()
      }
    })
  },
})
