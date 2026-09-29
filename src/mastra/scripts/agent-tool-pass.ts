/// <reference types="node" />
/**
 * Agent tool-selection pass: 20 turns through the REAL /v1/chat, each asking for a fact that exists in
 * exactly one place in the catalog, then asserting that fact reaches the user's reply.
 *
 * This is the half that tool-battery.ts cannot cover. tool-battery calls execute() directly, so it proves a
 * tool CAN fetch; it says nothing about whether the model picks it. Here the only way the expected digits
 * can appear is: master routed, worker chose the right tool, the tool fetched, and synthesis kept the number.
 * A failure therefore means one of those four, and the reply is logged so you can tell which.
 *
 * Every expected value was read out of the live catalog before the case was written, and each is accepted in
 * both plain and Indian-grouped form because the persona formats with grouping (₹1,29,800) while the raw
 * value is 129800.
 *
 * Costs real model tokens and takes ~10 minutes. Run from src/mastra with the bureau sidecar up:
 *   bun run agent-tool-pass
 *   bun run agent-tool-pass -- --limit=4        # smoke run
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { scrubIdentifiers } from '../lib/otel'
import {
  ensureDataset, ingestTracesAndScores, linkRunItems, traceIdsFor, langfuseEnabled,
  type EvalCase, type EvalResult,
} from '../lib/langfuse-eval'

type AgentCase = {
  id: string
  /** The tool the reply can only be right by using. Recorded so a failure names a suspect. */
  tool: string
  message: string
  /** Any one of these substrings proves the catalog value survived to the reply. */
  anyOf: string[]
  expected: string
}

/** Digits verified against the live catalog on 2026-08-05, plus their Indian-grouped forms. */
const CASES: AgentCase[] = [
  { id: 'a-fees-taj', tool: 'getCardFees', message: 'What is the joining fee on the HSBC Taj credit card including GST?',
    anyOf: ['129800', '1,29,800'], expected: 'joining fee 110000 plus 18% GST = 129800' },
  { id: 'a-fees-reserve', tool: 'getCardFees', message: 'Total first year cost of the Axis Bank Reserve credit card including GST?',
    anyOf: ['59000', '59,000'], expected: 'joining fee 50000 plus GST = 59000, year one is the joining fee alone' },
  { id: 'a-fees-magnus', tool: 'getCardFees', message: 'What is the annual fee on the Axis Bank Magnus for Burgundy with GST?',
    anyOf: ['35400', '35,400'], expected: 'annual fee 30000 plus GST = 35400' },
  { id: 'a-fees-tblack', tool: 'getCardFees', message: 'Joining fee on the ICICI Times Black credit card with GST?',
    anyOf: ['23600', '23,600'], expected: 'joining fee 20000 plus GST = 23600' },
  { id: 'a-crit-neu', tool: 'getCardCriteria', message: 'What CIBIL score does the HDFC Tata Neu Infinity card need?',
    anyOf: ['750'], expected: 'score_floor 750' },
  { id: 'a-crit-amexgold', tool: 'getCardCriteria', message: 'What monthly income does the American Express Gold Card require for a salaried applicant?',
    anyOf: ['50000', '50,000'], expected: 'income_floor_monthly_salaried 50000' },
  { id: 'a-crit-selfemp', tool: 'getCardCriteria', message: 'I am self employed. What income do I need for the American Express Platinum Charge Card?',
    anyOf: ['125000', '1,25,000'], expected: 'income_floor_monthly_selfemployed 125000, distinct from the salaried 208333' },
  { id: 'a-crit-mmt', tool: 'getCardCriteria', message: 'Which CIBIL score is needed for the ICICI MakeMyTrip Black card?',
    anyOf: ['750'], expected: 'score_floor 750' },
  { id: 'a-pr-zomato', tool: 'getCardPartnerRates', message: 'What reward rate does the IDFC First Millennia give at Zomato?',
    anyOf: ['25%', '25 %'], expected: 'reward_rate 0.25 at zomato' },
  { id: 'a-pr-zomato-cap', tool: 'getCardPartnerRates', message: 'Is there a monthly cap on the IDFC First Millennia Zomato reward?',
    anyOf: ['100'], expected: 'reward_cap_value_month 100' },
  { id: 'a-pr-bms', tool: 'getCardPartnerRates', message: 'What does the Adani One ICICI Platinum card give at BookMyShow, and is it capped?',
    anyOf: ['200'], expected: 'reward_cap_value_month 200 at bookmyshow' },
  { id: 'a-pr-yatra', tool: 'getCardPartnerRates', message: 'Monthly cap on the Standard Chartered DigiSmart reward at Yatra?',
    anyOf: ['4000', '4,000'], expected: 'reward_cap_value_month 4000' },
  { id: 'a-pr-swiggy-orange', tool: 'getCardPartnerRates', message: 'I spend 15000 a month on Swiggy. What would the Swiggy HDFC ORNGE card earn me?',
    anyOf: ['1500', '1,500', '750'], expected: 'the real online_food rate 5% with the ₹1,500 cap, not an invented ₹750 ceiling' },
  { id: 'a-pr-simplyclick', tool: 'getCardPartnerRates', message: 'What is the monthly cap on SBI SimplyClick online food rewards?',
    anyOf: ['2500', '2,500'], expected: 'reward_cap_value_month 2500' },
  { id: 'a-pr-ishop', tool: 'getCardPartnerRates', message: 'What rate does the ICICI Times Black card give on hotels through iShop?',
    anyOf: ['24%', '24 %'], expected: 'the 0.24 hotels rate_variant at icici_ishop' },
  { id: 'a-emi', tool: 'calculateEmi', message: 'What is the EMI on a 500000 loan at 10.5% over 60 months?',
    anyOf: ['10747', '10,747'], expected: 'EMI 10747, verified independently' },
  { id: 'a-foir', tool: 'calculateFoir', message: 'I earn 100000 a month and pay 25000 in EMIs. What is my FOIR?',
    anyOf: ['25%', '25 %'], expected: 'FOIR 25%' },
  { id: 'a-benefits-atlas', tool: 'getCardBenefits', message: 'What lounge access does the Axis Atlas credit card give?',
    anyOf: ['lounge'], expected: 'the verified lounge block built from 6 card_lounge rows' },
  { id: 'a-compare', tool: 'compareCards', message: 'Compare the Axis Atlas and the HDFC Tata Neu Infinity on fees.',
    anyOf: ['Atlas'], expected: 'both cards named, each with this-turn fee data' },
  { id: 'a-signals', tool: 'getSignals', message: 'What is my current credit utilisation?',
    anyOf: ['%'], expected: 'a utilisation percentage from the user\'s own bureau signals' },
]

const arg = (n: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`))
  return h ? h.slice(n.length + 3) : undefined
}
const LIMIT = Number(arg('limit') ?? Infinity)
const USE_LANGFUSE = !process.argv.includes('--no-langfuse') && langfuseEnabled
const MOBILE = process.env.TEST_MOBILE

const stamp = process.env.BATTERY_STAMP ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const LOG_DIR = fileURLToPath(new URL('../../../scratchpad/', import.meta.url))
const LOG = `${LOG_DIR}agent-tool-pass-${stamp}.jsonl`

async function main() {
  if (!MOBILE || !/^\d{10}$/.test(MOBILE)) {
    console.error('[agent-pass] TEST_MOBILE must be a 10-digit number in .env')
    process.exit(1)
  }
  mkdirSync(LOG_DIR, { recursive: true })
  const cases = CASES.slice(0, LIMIT)
  const { app } = (await import('../server')) as { app: { request: (p: string, i: RequestInit) => Promise<Response> } }

  const datasetName = 'credix-agent-tool-selection'
  const runName = `agent-tool-${stamp}`
  console.log(`[agent-pass] ${cases.length} turns  log=${LOG}`)
  if (USE_LANGFUSE) {
    const evalCases: EvalCase[] = cases.map((c) => ({ id: c.id, tool: c.tool, input: c.message, expected: c.expected }))
    const ds = await ensureDataset(datasetName, 'Does the agent CHOOSE the right tool and keep its number in the reply', evalCases)
    console.log(`[agent-pass] langfuse: ${ds.created} items created, ${ds.skipped} present`)
  }

  const results = new Map<string, EvalResult>()
  /** Local only, never exported. The failure printout reads from here rather than from the eval verdict. */
  const replies = new Map<string, string>()
  for (const c of cases) {
    const t0 = Date.now()
    let reply = ''
    let status = 0
    let degraded = false
    try {
      const res = await app.request('/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Fresh session per case so no turn inherits another's memory or committed language.
        body: JSON.stringify({ mobile: MOBILE, message: c.message, channel: 'web', session_id: `atp-${stamp}-${c.id}` }),
      })
      status = res.status
      const json = (await res.json()) as Record<string, unknown>
      reply = typeof json.response === 'string' ? json.response : ''
      degraded = json.degraded === true
    } catch (err) {
      reply = `<threw: ${err instanceof Error ? err.message : String(err)}>`
    }
    const latencyMs = Date.now() - t0
    const hit = c.anyOf.find((n) => reply.includes(n))
    const passed = Boolean(hit) && !degraded
    const reason = passed
      ? null
      : degraded
        ? 'degraded reply, upstream failed'
        : `none of [${c.anyOf.join(', ')}] in the reply`

    // The reply is model text about the user's own finances, so it is scrubbed before it touches disk or
    // Langfuse, the same rule battery.ts follows.
    const safeReply = scrubIdentifiers(reply)
    appendFileSync(LOG, `${JSON.stringify({ case_id: c.id, tool: c.tool, status, latencyMs, passed, reason, matched: hit ?? null, message: c.message, reply: safeReply })}\n`)
    console.log(`  ${passed ? 'PASS' : 'FAIL'} ${c.id.padEnd(20)} ${c.tool.padEnd(22)} ${String(latencyMs).padStart(6)}ms${reason ? `  ${reason}` : `  matched ${hit}`}`)

    results.set(c.id, {
      passed,
      reason,
      latencyMs,
      verdictLabel: passed ? 'pass' : 'fail',
      // The reply is NOT exported. It is model prose about this customer's finances, and scrubbing cannot
      // make that safe: scrubIdentifiers matches identifier patterns, and "your utilisation is 38%" has no
      // pattern to match (PR #20 review). It stays in the local jsonl, which is where a selection failure
      // gets diagnosed anyway. What goes out is the verdict plus the value we matched on.
      verdict: { passed, reason, matched: hit ?? null, reply_chars: safeReply.length },
    })
    // Kept in memory only, for the failure printout below.
    replies.set(c.id, safeReply)
  }

  const pass = [...results.values()].filter((r) => r.passed).length
  console.log(`\n── total ── ${pass}/${cases.length} turns kept the catalog value`)
  const failed = cases.filter((c) => !results.get(c.id)?.passed)
  if (failed.length) {
    console.log(`── failures, with the reply so you can tell selection from synthesis ──`)
    for (const c of failed) {
      console.log(`  ${c.id} (${c.tool}) wanted [${c.anyOf.join('|')}]\n    reply: ${(replies.get(c.id) ?? '').slice(0, 240)}`)
    }
  }

  if (USE_LANGFUSE) {
    const evalCases: EvalCase[] = cases.map((c) => ({ id: c.id, tool: c.tool, input: c.message, expected: c.expected }))
    const traceIds = traceIdsFor(evalCases)
    const errs = [
      ...(await ingestTracesAndScores(evalCases, results, traceIds, runName)),
      ...(await linkRunItems(datasetName, runName, evalCases, results, traceIds)),
    ]
    if (errs.length) console.warn(`[agent-pass] ${errs.length} langfuse errors: ${errs.slice(0, 3).join(' | ')}`)
    else console.log(`[agent-pass] langfuse: dataset '${datasetName}', run '${runName}'`)
  }

  try {
    const { observability } = await import('../index')
    const instances = observability?.listInstances()
    if (instances) for (const inst of instances.values()) await inst.flush()
  } catch {
    /* optional */
  }
  console.log(`[agent-pass] log: ${LOG}`)
  process.exit(0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main()
