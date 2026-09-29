# getCardFullProfile tool + creditCardAgent strengthening

Date: 2026-07-16
Branch: `feat/full-card-profile-agents` (stacked on `feat/cred-catalog-tools`, PR #15)
Target PR: #16, base `feat/cred-catalog-tools`

## Problem

A full picture of one card currently costs the agent 2 to 3 tool calls: `getCardDetails` returns
fees, earn rates, lounge, fuel, milestones, transfer partners, and eligibility, but deliberately
excludes structured benefits (insurance/dining/welcome/movie => `getCardBenefits`) and merchant
partner rates (`getCardPartnerRates`). Separately, `creditCardAgent` runs on the bare `RAHUL_PERSONA`
with no card-domain discipline, so it can answer from memory, invent unpublished fields, or miss
edition ambiguity (Infinia vs Infinia Metal).

## Scope

Two changes, both on the credit-card path only:

1. A new `getCardFullProfile` tool that returns everything about one card in a single call.
2. A `CREDIT_CARD_ADDENDUM` appended to `creditCardAgent` instructions, plus wiring the tool in.

Naming: the tool follows the existing `getCard*` family (`getCardDetails`, `getCardFees`,
`getCardBenefits`, `getCardCriteria`, `getCardPartnerRates`).

Out of scope (dropped after scoping): strengthening scoreImprovementAgent, insuranceAgent, or
credixAgent; any change to the three granular tools' behaviour.

## Feature 1: getCardFullProfile

New tool in `src/mastra/tools/card-catalog.ts`. The three granular tools stay untouched (they remain
the right choice for narrow questions and are reused here).

### Shared schema

`getCardDetails`' output schema is extracted into a named `cardDetailsOutput` (single source of
truth). `getCardFullProfile` composes it rather than redeclaring it:

```
cardFullProfileOutput = cardDetailsOutput
  .omit({ insurance: true })          // real insurance benefits are embedded under `benefits`
  .extend({
    benefits: z.array(benefitRow),
    benefits_grouped: z.record(z.string(), z.array(benefitRow)),
    partner_rates: z.array(partnerRateRow),
  })
```

### Composition seam

Mastra types `Tool.execute` loosely (optional value, widened return), so a cross-tool `.execute()`
call loses its result type. One adapter isolates this:

```
runCatalogTool(tool, input, schema):
  invoke tool.execute(input) once, then schema.parse(result)
```

Parsing validates at the boundary (a direct `.execute()` call skips Mastra's own output validation)
and yields a fully typed result via `z.infer`. The single unavoidable cast lives inside the adapter;
callers stay typed.

### Resolution and fan-out

Resolution is anchored on `getCardDetails` (the single source of truth for fuzzy matching and edition
ambiguity); its resolved `card_id` is fed to the other two so all three sections describe the same
card:

```
getCardFullProfile({ card }):
  details = await runCatalogTool(getCardDetails, { card }, cardDetailsOutput)
  { insurance, ...detail } = details            // drop the placeholder
  if (!details.found):
     return { ...detail, benefits: [], benefits_grouped: {}, partner_rates: [] }   // fail-soft
  [benefits, partner] = await Promise.all([
     runCatalogTool(getCardBenefits, { card: details.card_id }, benefitsView),
     runCatalogTool(getCardPartnerRates, { card: details.card_id }, partnerRatesView),
  ])
  return { ...detail, benefits: benefits.benefits, benefits_grouped: benefits.grouped,
           partner_rates: partner.rows }
```

`benefitsView` and `partnerRatesView` are the exact subsets consumed (parse strips the rest), so the
merge depends only on the fields it uses. Benefits and partner rates run in parallel after the id
resolves. `partner_rates` is often empty when a card models accelerated rates as category earn rates,
which already appear under `rewards.earn_rates`: that is correct, not a miss.

### Fail-soft (inherited from getCardDetails)

- `DATABASE_URL` unset: `getCardDetails` returns `CATALOG_DB_UNAVAILABLE`; propagated as
  `found:false, error: CATALOG_DB_UNAVAILABLE`.
- Card miss: `found:false`, error string with an exaSearch hint.
- PII-safe span `catalog.full_profile` (counts/outcomes only), matching the other catalog tools.

## Feature 2: creditCardAgent strengthening

`CREDIT_CARD_ADDENDUM` (exported const in `src/mastra/agents/credit-card.ts`) set as
`instructions: \`${RAHUL_PERSONA}\n\n${CREDIT_CARD_ADDENDUM}\``, and `getCardFullProfile` wired into
the agent's `tools`. Addendum directives (the persona rules still govern the model's replies: digits
only, and no em-dash or en-dash in the reply text):

- Source card facts from the catalog tools first: `getCardFullProfile` for a full rundown, the
  granular tools for narrow questions; never from memory. Call `exaSearch` only when the catalog has no
  match for the card or to check a suspected recent change, never to fill in a single null field.
- Null or absent field on a returned card: say it is not published; never invent a number. A tool error
  (catalog unavailable or a partial lookup failure) means that part could not be checked, not "not published".
- When `ambiguous_with` is set, name the exact edition quoted and note the ambiguity.
- Do not repeat a tool call already made this turn.
- Approval odds via `checkCardEligibility` + `getSignals`, never a guarantee.
- Insurance cover amounts are protection limits, not earnable value; use "up to" for maxima.

## Tests

- `src/mastra/__tests__/agents.test.ts`: `creditCardAgent` tool set includes `getCardFullProfile`;
  instructions contain `CREDIT_CARD_ADDENDUM`; the other three agents do not.
- `src/mastra/__tests__/card-catalog.test.ts`: `getCardFullProfile` merge (details + benefits +
  partner rates for one card via a shared SQL-routing responder), not-found fail-soft, and
  `DATABASE_URL` unset.

## Verification

`bun test` (agents + card-catalog green) and `bunx tsc --noEmit -p src/mastra/tsconfig.json` clean.

## Files touched

- `src/mastra/tools/card-catalog.ts` (extract cardDetailsOutput, runCatalogTool adapter, new tool)
- `src/mastra/agents/credit-card.ts` (addendum const + instructions + tool wiring)
- `src/mastra/__tests__/agents.test.ts`
- `src/mastra/__tests__/card-catalog.test.ts`
