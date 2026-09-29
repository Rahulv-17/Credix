/* ============================================================
   Card-name / spend-label resolution — the NLU layer shared by all card catalog tools.

   Ported from Cred (agent/src/mastra/lib/catalog-cards.ts) VERBATIM except the DB accessor: it reads
   Credix's lazy catalog pool (lib/catalog-db) instead of Cred's module-level `pool`. All reward
   math still lives in the SQL function catalog.rank_cards_for_spend (filtering/schema/eligible_cards.sql);
   this file owns only fuzzy label/name -> catalog-code resolution.

   The read tools (getCardFees/getCardBenefits/getCardPartnerRates/getCardDetails) use cardMatchSql,
   resolveCardCandidates, editionAmbiguity, issuerMatches. The ranking helpers (loadCategories,
   rankCardsForInterview) are ported too so recommendCard can build on them later; they are unused by
   the read tools.
   ============================================================ */
import { getCatalogPool, CATALOG_DB_UNAVAILABLE } from './catalog-db'

export interface InterviewSpend {
  category: string // any interview label, display name, or catalog code
  monthly: number
  via_upi?: boolean // true = spend settled via UPI
}

export interface RewardRow {
  category_code: string
  display_name: string
  rate: number // effective reward rate applied (0.05 = 5%)
  monthly_amount: number // monthly spend this row covers
  reward_annual: number
}

export interface LoungeAccess {
  domestic_unlimited: boolean
  intl_unlimited: boolean
  domestic_visits_year: number | null // null when unlimited OR no access
  intl_visits_year: number | null
  spend_required: number | null // minimum spend to unlock access, if gated
  /** Cadence spend_required is measured over — 'quarterly' | 'annual' | 'trailing_3_months' |
   *  'trailing_6_months' | 'lifetime' | null. Do NOT assume quarterly (finding 2k — the gate can
   *  be any of these; displaying the wrong unit understates or overstates the real requirement). */
  spend_required_period: string | null
}

export interface ShapedCard {
  card_id: string
  name: string
  issuer_name: string
  tier: string | null
  annual_fee: number
  ntc_ok: boolean | null
  invite_only: boolean | null
  income_floor_monthly: number | null
  reward_breakdown: RewardRow[]
  reward_annual: number
  effective_fee: number
  fee_waived: boolean
  surcharge_annual: number
  net_value: number
  lounge: LoungeAccess
}

export interface RankResult {
  recommended: ShapedCard | null
  alternatives: ShapedCard[]
  resolvedSpend: { code: string; display_name: string; monthly: number }[]
  /** Count of eligible cards BEFORE any issuer filter or hard constraint — lets a caller say
   *  "0 from Axis, but N other eligible cards" instead of a generic empty result. */
  totalEligibleCount: number
}

/** Match a user-supplied issuer/bank name against a card's issuer_name (catalog rows only
 *  carry issuer_name, not issuer_code). Case-insensitive, with an 'amex' -> 'american express'
 *  alias plus loose two-way substring matching, so "Axis"/"Axis Bank"/"HDFC"/"Amex" resolve.
 *  Only 'amex' has an explicit alias; other abbreviations resolve only when issuer_name
 *  literally contains them (e.g. "SBI" matches "SBI Cards", not "State Bank of India"). */
export function issuerMatches(issuerName: string, query: string): boolean {
  const alias: Record<string, string> = { amex: 'american express' }
  const q = (alias[query.trim().toLowerCase()] ?? query.trim().toLowerCase()).replace(/\s+/g, ' ')
  if (!q) return true
  const iname = issuerName.toLowerCase()
  return iname.includes(q) || q.includes(iname.split(' ')[0])
}

function db() {
  const pool = getCatalogPool()
  if (!pool) throw new Error(CATALOG_DB_UNAVAILABLE)
  return pool
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

// Fuzzy synonyms for labels the agent or user might say.
// Tried when neither the exact code nor any DB display_name matches.
// First candidate that exists in the DB wins; falls back to 'general'.
const SYNONYMS: Record<string, string[]> = {
  food: ['online_food', 'dining'],
  fooddelivery: ['online_food'],
  onlinefood: ['online_food'],
  swiggy: ['online_food'],
  zomato: ['online_food'],
  quickcommerce: ['quick_commerce'],
  blinkit: ['quick_commerce'],
  zepto: ['quick_commerce'],
  instamart: ['quick_commerce'],
  grocery: ['grocery_offline', 'grocery_online'],
  groceries: ['grocery_offline', 'grocery_online'],
  onlinegrocery: ['grocery_online'],
  offlinegrocery: ['grocery_offline'],
  supermarket: ['grocery_offline'],
  dmart: ['grocery_offline'],
  bigbasket: ['grocery_online'],
  restaurant: ['dining'],
  cafe: ['cafe_qsr'],
  qsr: ['cafe_qsr'],
  travel: ['flights', 'hotels'],
  flight: ['flights'],
  airline: ['flights'],
  hotel: ['hotels'],
  makemytrip: ['flights', 'hotels'],
  ixigo: ['flights'],
  cab: ['cabs'],
  uber: ['cabs'],
  ola: ['cabs'],
  rapido: ['cabs'],
  railway: ['train'],
  irctc: ['train'],
  toll: ['tolls'],
  fastag: ['tolls'],
  petrol: ['fuel'],
  diesel: ['fuel'],
  evcharging: ['ev_charging'],
  shopping: ['ecommerce'],
  online: ['ecommerce'],
  amazon: ['ecommerce'],
  flipkart: ['ecommerce'],
  fashion: ['fashion_online'],
  myntra: ['fashion_online'],
  nykaa: ['beauty_online'],
  beauty: ['beauty_online'],
  electronics: ['electronics_online', 'electronics_offline'],
  entertainment: ['entertainment'],
  ott: ['ott_video'],
  netflix: ['ott_video'],
  hotstar: ['ott_video'],
  spotify: ['ott_music'],
  streaming: ['ott_video'],
  movies: ['movies'],
  pvr: ['movies'],
  bookmyshow: ['movies'],
  utility: ['utilities'],
  utilities: ['utilities'],
  bills: ['utilities'],
  electricity: ['electricity'],
  mobile: ['mobile_postpaid'],
  recharge: ['mobile_prepaid'],
  broadband: ['broadband_dth'],
  dth: ['broadband_dth'],
  pharmacy: ['pharmacy'],
  health: ['health'],
  rent: ['rent'],
  insurance: ['insurance'],
  emi: ['emi'],
  loanemi: ['emi'],
  sip: ['mutual_fund'],
  mutualfund: ['mutual_fund'],
  tax: ['govt_tax'],
  govtpayment: ['govt_tax'],
  wallet: ['wallet'],
  paytm: ['wallet'],
  upi: ['upi'],
  cashback: ['general'],
  jewellery: ['jewellery'],
  jewelry: ['jewellery'],
  tanishq: ['jewellery'],
  caratlane: ['jewellery'],
  malabar: ['jewellery'],
  kalyan: ['jewellery'],
  gaming: ['gaming'],
  steam: ['gaming'],
  googleplay: ['gaming'],
  appstore: ['gaming'],
  mobilegame: ['gaming'],
  ingamepurchase: ['gaming'],
  utilitiesmisc: ['utilities'],
}

/** Resolve an interview label to a canonical catalog code.
 *  1. Exact norm(code) or norm(display_name) match in DB
 *  2. Synonym key or substring overlap → try each candidate
 *  3. Fall back to 'general' */
export function resolveCode(label: string, known: Map<string, string>, umbrellas?: Set<string>): string {
  return resolveCodeWithFlag(label, known, umbrellas).code
}

/** Same as resolveCode but also signals whether the result was a real match
 *  or a silent fallback to 'general'. Callers that need to warn the user
 *  (e.g. card-earn-rate) should use this instead. */
export function resolveCodeWithFlag(
  label: string,
  known: Map<string, string>,
  umbrellas: Set<string> = new Set(),
): { code: string; silentFallback: boolean } {
  const n = norm(label)
  if (known.has(n)) return { code: known.get(n)!, silentFallback: false }

  // Substring overlap needs a minimum length on the USER'S label: a short label matching INSIDE a
  // longer synonym key is usually a false hit ("misc" matched inside "utilitiesmisc"). A short
  // label may still contain a full key ("fuel" in "fuel spends"), so n.includes(k) stays.
  const keys = [
    n,
    ...Object.keys(SYNONYMS).filter((k) => k !== n && (n.includes(k) || (n.length >= 5 && k.includes(n)))),
  ]
  const candidates: Array<{ code: string; keyLen: number }> = []
  for (const key of keys) {
    for (const cand of SYNONYMS[key] ?? []) {
      if (known.has(norm(cand))) candidates.push({ code: known.get(norm(cand))!, keyLen: key.length })
    }
  }
  for (const [k, code] of known) {
    if (k.length >= 4 && n.includes(k)) candidates.push({ code, keyLen: k.length })
  }
  if (candidates.length) {
    candidates.sort((a, b) => {
      const ua = umbrellas.has(a.code) ? 1 : 0
      const ub = umbrellas.has(b.code) ? 1 : 0
      if (ua !== ub) return ua - ub // specific beats umbrella
      return b.keyLen - a.keyLen // then the longest matched key
    })
    return { code: candidates[0].code, silentFallback: false }
  }
  const code = known.has('general') ? 'general' : (known.values().next().value ?? 'general')
  return { code, silentFallback: true }
}

/* ------------------------------------------------------------
   Card-name resolution (shared by all card tools)

   A single contiguous ILIKE ('%axis magnus%') misses stored names with intervening words
   ("Axis Bank Magnus Credit Card"). Instead, AND one ILIKE per whitespace token so word order gaps
   don't matter. Exact id match always wins; among multiple name matches the shortest wins.
   ------------------------------------------------------------ */

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

// Abbreviations that are not substrings of any stored card name. Expanded token-wise before matching.
const CARD_ALIASES: Record<string, string> = {
  amex: 'american express',
  mmt: 'makemytrip',
}

/** Build the WHERE / ORDER BY fragments and params for a card lookup.
 *  Matching: exact id, OR all tokens present as substrings of the name (AND), OR a typo-tolerant
 *  trigram word_similarity match (pg_trgm). */
export function cardMatchSql(input: string): { where: string; order: string; params: string[] } {
  const raw = input.trim()
  const tokens = Array.from(
    new Set(
      raw
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((t) => (CARD_ALIASES[t] ?? t).split(' ')),
    ),
  )
  // Fuzzy matching compares only the DISTINCTIVE part of the name: nearly every catalog name ends in
  // "Credit Card" and most start with "<Issuer> Bank", so those generic tokens inflate trigram
  // similarity between unrelated names. Strip credit/card(s)/bank from BOTH sides before scoring;
  // exact-id and substring matching still see the full strings.
  const fuzzyQuery = raw.replace(/\b(credit|cards?|bank)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  const STRIPPED_NAME = `regexp_replace(name, '\\y(credit|cards?|bank)\\y', ' ', 'gi')`
  const fuzzyParam = `$${tokens.length + 2}`
  const tokenAnd = tokens.length
    ? tokens.map((_, i) => `name ILIKE '%' || $${i + 2} || '%'`).join(' AND ')
    : 'FALSE'
  const substr = `(${tokenAnd})`
  // Explicit 0.4 threshold (the <% default 0.6 is too strict for real typos). Gated behind a minimum
  // length on the STRIPPED query so short strings can't false-positive against a different real name.
  const fuzzy = fuzzyQuery.length >= 6 ? `word_similarity(${fuzzyParam}, ${STRIPPED_NAME}) > 0.4` : 'FALSE'
  return {
    where: `id = $1 OR ${substr} OR ${fuzzy}`,
    order: [
      '(id = $1) DESC',
      '(lower(name) = lower($1)) DESC',
      `${substr} DESC`,
      "(CASE populate_status WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END) ASC",
      '(accepting_new_applications IS NOT FALSE) DESC',
      '(is_active IS NOT FALSE) DESC',
      `word_similarity(${fuzzyParam}, ${STRIPPED_NAME}) DESC`,
      'length(name) ASC',
    ].join(', '),
    params: [raw, ...tokens.map(likeEscape), fuzzyQuery],
  }
}

// Category route substitutes — max-value-leads mapping (user-set 2026-07-10), priority order kept.
export const ROUTE_SUBSTITUTES: Record<string, string[]> = {
  grocery_online: ['quick_commerce'],
  dining: ['online_food'],
  cafe_qsr: ['online_food'],
  fashion_online: ['ecommerce'],
  beauty_online: ['ecommerce'],
  electronics_online: ['ecommerce'],
  home_furniture_online: ['ecommerce'],
  department_store: ['ecommerce'],
  pharmacy: ['ecommerce'],
}

export interface CardMatch {
  id: string
  name: string
}

/** Names that contain EVERY token the user typed are genuinely ambiguous with the picked card
 *  ("regalia" matches base + Gold). Value tools use it to state which edition is shown. */
export function editionAmbiguity(query: string, pickedName: string, others: CardMatch[]): string[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  const containsAll = (name: string) => tokens.every((t) => name.toLowerCase().includes(t))
  if (!containsAll(pickedName)) return []
  return others.filter((o) => containsAll(o.name)).map((o) => o.name)
}

/** Resolve a query to its ranked card candidates (best first). */
export async function resolveCardCandidates(input: string, limit = 6): Promise<CardMatch[]> {
  const m = cardMatchSql(input)
  const { rows } = await db().query<CardMatch>(
    `SELECT id, name FROM catalog.card WHERE ${m.where} ORDER BY ${m.order} LIMIT ${limit}`,
    m.params,
  )
  return rows
}

export interface CategoryMeta {
  known: Map<string, string> // norm(code | display_name) → canonical code
  label: Map<string, string> // code → display_name
  umbrellas: Set<string> // codes that are PARENTS of other codes (broad groupings)
}

export async function loadCategories(): Promise<CategoryMeta> {
  const { rows } = await db().query<{ code: string; display_name: string; parent_code: string | null }>(
    'SELECT code, display_name, parent_code FROM catalog.spend_category',
  )
  const known = new Map<string, string>()
  const label = new Map<string, string>()
  const umbrellas = new Set<string>()
  for (const r of rows) {
    known.set(norm(r.code), r.code)
    known.set(norm(r.display_name), r.code)
    label.set(r.code, r.display_name)
    if (r.parent_code) umbrellas.add(r.parent_code)
  }
  return { known, label, umbrellas }
}

/** SQL result row from catalog.rank_cards_for_spend */
interface RankRow {
  card_id: string
  name: string
  issuer_name: string
  tier: string | null
  annual_fee: number | null
  ntc_ok: boolean | null
  invite_only: boolean | null
  income_floor_monthly: number | null
  reward_annual: number
  reward_breakdown: RewardRow[] // pg returns jsonb as parsed object
  effective_fee: number
  fee_waived: boolean
  surcharge_annual: number
  net_value: number
  rank: number
}

const NO_LOUNGE: LoungeAccess = {
  domestic_unlimited: false,
  intl_unlimited: false,
  domestic_visits_year: null,
  intl_visits_year: null,
  spend_required: null,
  spend_required_period: null,
}

function toShapedCard(r: RankRow): ShapedCard {
  const annualFee = r.annual_fee ?? 0
  return {
    card_id: r.card_id,
    name: r.name,
    issuer_name: r.issuer_name,
    tier: r.tier,
    annual_fee: annualFee,
    ntc_ok: r.ntc_ok,
    invite_only: r.invite_only,
    income_floor_monthly: r.income_floor_monthly,
    reward_breakdown: Array.isArray(r.reward_breakdown) ? r.reward_breakdown : [],
    reward_annual: Math.round(r.reward_annual),
    effective_fee: r.effective_fee,
    fee_waived: r.fee_waived,
    surcharge_annual: Math.round(r.surcharge_annual),
    net_value: Math.round(r.net_value),
    lounge: NO_LOUNGE, // filled by attachLounge()
  }
}

async function attachLounge(cards: ShapedCard[]): Promise<void> {
  if (!cards.length) return
  const ids = cards.map((c) => c.card_id)
  const { rows } = await db().query<{
    card_id: string
    lounge_type: string
    visits_per_period: number | null
    period: string
    spend_required: number | null
    spend_requirement_period: string | null
  }>(
    // Base tier only — Gold/Platinum are spend-unlocked upgrades, not the guaranteed baseline (finding 27).
    // tier IS NULL is the base row (see getCardBenefits' `tier NULLS FIRST`); NOT IN alone drops it
    // via SQL three-valued logic, so keep NULL explicitly or base lounge access under-reports.
    `SELECT card_id, lounge_type, visits_per_period, period, spend_required, spend_requirement_period
     FROM catalog.card_lounge WHERE card_id = ANY($1) AND (tier IS NULL OR tier NOT IN ('gold','platinum'))`,
    [ids],
  )
  const toAnnual = (r: { visits_per_period: number | null; period: string }) =>
    r.visits_per_period !== null ? r.visits_per_period * (r.period === 'quarterly' ? 4 : 1) : 0

  for (const card of cards) {
    const lr = rows.filter((r) => r.card_id === card.card_id)
    const dom = lr.filter((r) => r.lounge_type === 'domestic')
    const intl = lr.filter((r) => r.lounge_type === 'international')
    const domestic_unlimited = dom.some((r) => r.visits_per_period === null)
    const intl_unlimited = intl.some((r) => r.visits_per_period === null)
    const gatedRows = lr.filter((r): r is typeof r & { spend_required: number } => r.spend_required != null)
    const minGated = gatedRows.length
      ? gatedRows.reduce((min, r) => (r.spend_required < min.spend_required ? r : min))
      : null
    card.lounge = {
      domestic_unlimited,
      intl_unlimited,
      domestic_visits_year: domestic_unlimited || dom.length === 0 ? null : dom.reduce((acc, r) => acc + toAnnual(r), 0),
      intl_visits_year: intl_unlimited || intl.length === 0 ? null : intl.reduce((acc, r) => acc + toAnnual(r), 0),
      spend_required: minGated?.spend_required ?? null,
      spend_required_period: minGated?.spend_requirement_period ?? minGated?.period ?? null,
    }
  }
}

export async function rankCardsForInterview(opts: {
  spend: InterviewSpend[]
  employmentType?: string | null
  focusCategory?: string
  excludeIds?: string[]
  issuerFilter?: string
  restrictToCardIds?: string[]
  hardConstraints?: {
    lounge?: 'domestic_unlimited' | 'intl_unlimited' | 'any_unlimited'
    minTier?: 'mid' | 'premium' | 'super' | 'super_premium'
  }
}): Promise<RankResult> {
  const { known, label, umbrellas } = await loadCategories()

  // Resolve labels → codes, collapse duplicates (sum monthly, OR via_upi)
  const collapsed = new Map<string, { code: string; monthly: number; via_upi: boolean }>()
  for (const s of opts.spend) {
    if (!Number.isFinite(s.monthly) || s.monthly <= 0) continue
    const code = resolveCode(s.category, known, umbrellas)
    const ex = collapsed.get(code)
    if (ex) {
      ex.monthly += s.monthly
      ex.via_upi = ex.via_upi || (s.via_upi ?? false)
    } else collapsed.set(code, { code, monthly: s.monthly, via_upi: s.via_upi ?? false })
  }

  const resolvedSpend = [...collapsed.values()].map((s) => ({
    code: s.code,
    display_name: label.get(s.code) ?? s.code,
    monthly: s.monthly,
  }))

  if (!resolvedSpend.length) return { recommended: null, alternatives: [], resolvedSpend: [], totalEligibleCount: 0 }

  const spendJson = JSON.stringify(
    [...collapsed.values()].map((s) => ({
      category_code: s.code,
      monthly_amount: Math.round(s.monthly),
      via_upi: s.via_upi,
    })),
  )

  // Ranking is intentionally income-agnostic: pass NULL so the SQL bypasses the income-floor filter.
  // Eligibility is assessed separately; ranking shows all active, non-invite-only cards ordered purely
  // by reward value for this spend mix. (Re-add an income arg here when income-aware ranking is wired.)
  const { rows } = await db().query<RankRow>('SELECT * FROM catalog.rank_cards_for_spend($1, $2::jsonb, $3)', [
    null,
    spendJson,
    opts.employmentType ?? null,
  ])

  let shaped = rows.map(toShapedCard)

  if (opts.excludeIds?.length) {
    const excl = new Set(opts.excludeIds)
    shaped = shaped.filter((c) => !excl.has(c.card_id))
  }

  await attachLounge(shaped)

  const totalEligibleCount = shaped.length

  if (opts.issuerFilter) {
    shaped = shaped.filter((c) => issuerMatches(c.issuer_name, opts.issuerFilter!))
  }

  if (opts.hardConstraints?.lounge) {
    const req = opts.hardConstraints.lounge
    shaped = shaped.filter((c) =>
      req === 'domestic_unlimited'
        ? c.lounge.domestic_unlimited
        : req === 'intl_unlimited'
          ? c.lounge.intl_unlimited
          : c.lounge.domestic_unlimited || c.lounge.intl_unlimited,
    )
  }

  if (opts.hardConstraints?.minTier) {
    const TIER_ORDER: Record<string, number> = { entry: 0, mid: 1, premium: 2, super: 3, super_premium: 4 }
    const floor = TIER_ORDER[opts.hardConstraints.minTier]
    shaped = shaped.filter((c) => c.tier != null && (TIER_ORDER[c.tier] ?? -1) >= floor)
  }

  if (opts.restrictToCardIds?.length) {
    const only = new Set(opts.restrictToCardIds)
    shaped = shaped.filter((c) => only.has(c.card_id))
  }

  return {
    recommended: shaped[0] ?? null,
    alternatives: shaped.slice(1, 10),
    resolvedSpend,
    totalEligibleCount,
  }
}
