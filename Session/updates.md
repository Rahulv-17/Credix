# Session updates

One entry per meaningful commit: hash, date, files, reason. Newest first.

## 2026-07-09

Bureau signal engine (engine_full.py) integrated as the persona signal layer, end to end.
Spec/plan: docs/superpowers/{specs,plans}/2026-07-09-bureau-signal-engine*.

- `338ee46` signal-engine: port engine_full 62+34 set into user_story/engine.py with a flat-view
  adapter (_to_flat, inverse of scrub_mapping) — tier logic copied verbatim so parity holds.
- `5f200f9` signal-engine: compute_signals emits full tier1/tier2/compose (signals.py), SIGNALS_VERSION
  1->2, store.py stamps compute_ms — structural rubric preserved so classify + persona keep working.
- `4f09b00` signal-engine: lib/user-story-fetch.ts in-process signals cache + user-story.fetch span —
  mirrors bureau-fetch; only ok cached; PII-safe attrs + compute_ms passthrough.
- `b16e468` signal-engine: fetch signals once in Hono (server.ts), thread into workflow initData
  (credix-workflow.ts, optional) — same single-fetch posture as bureau, enrichment only.
- `d564c5b` signal-engine: getSignals tool (tools/signals.ts) wired into all specialists (agents/*) —
  module-cache pull with section narrowing + signals.lookup span.
- `dd8aac4` signal-engine: PII-safe signal summary injected into specialist prompts (lib/signal-summary.ts,
  makeAgentStep) — push path; exact age/income stay tool-pullable, not spelled in the prompt.
- `831988b` signal-engine: e2e proof the agent reads computed signals (signals-e2e.test.ts) +
  agents tool-set smoke test — real /v1/chat, push (prompt) + pull (getSignals from warm cache).
- `1ed83e1` infra: ruff clean api/app.py (import sort, wrap comment) — pre-existing lint blocking verify.

## 2026-07-08

- `e729bc9` infra: gitignore machine-local agent artifacts (.gitignore) — 40+ untracked entries
  (skill symlinks, .agents/, playwright logs, scratch dirs) drowned real git status.
- `e715c01` infra: track co-review, morning-ritual, sequence project skills (.claude/skills/) —
  workflow docs existed only on this machine.
- `aa0f37d` docs: Issue 002 bun test results into tasks/ (report + junit xml).
- `e6b75cd` frontend: pin `next dev` to port 5174 (interface/package.json) — default port clashed
  with other local dev servers.
- `ad1fd02` docs: latency plan verification + follow-ups in tasks/ — live probe confirms ~10s warm
  turns (baseline 15-18s).
- `e0fb2cc` infra: undici keep-alive dispatcher (src/mastra/lib/http-dispatcher.ts, server.ts,
  package.json) — 4s default keepAliveTimeout re-handshook TLS every turn.
- `9ffea32` agents: detach getBureauProfile from specialists (agents/*, agents.test) — tool
  duplicated the prompt-injected masked profile, costing an extra LLM round-trip per turn.
- `b15e24d` agents: Exa grounding concurrent with classify (steps/understand.ts, lib/web-grounding.ts,
  workflow, tests, READ_FLOW) — 0.7s search was serial inside agent.generate.
- `0bb407d` agents: intent-only understand.classify (steps/understand.ts, tests, .env.example) —
  the structured brief cost ~5s of every turn; specialist self-decomposes.

## 2026-07-16

- `9156bf9` agents: expand credix + credit-card worker prompts, add full-rundown length exception
  (agents/credix.ts, credit-card.ts, master.ts, agents.test.ts); the 200 word exception rides on
  the master too, else the worker rundown is recompressed to 120 at synthesis.
- `6d17f05` infra: make Honeycomb traces legible (tracing.ts, credix-workflow.ts, tasks/); outbound
  LLM/Exa spans were all named "POST"; now "llm <model>" / "exa.search" with a host fallback, dns/net
  noise dropped, and the app.delegated_workers attr fixed (Mastra names delegation tools agent-<key>).
- PR #17 opened, stacked on #16 (base feat/full-card-profile-agents): master/worker supervisor on
  Gemini, stronger prompts, legible traces. Verified live via bun run probe (6 turn session, all tools).

## 2026-07-29

- `d89fe2a` ZT-730: read user_id from a per request context, not the model's echo (server.ts,
  credix-workflow.ts, tools/{signals,statement,bureau}.ts, signals-tool.test.ts); the LLM had to
  echo user_id into every tool call, so a paraphrase read the wrong user. Reverses the 2026-07-13
  findings.md call; that note now carries a correction.
- `38352eb` ZT-729: Langfuse AI tracing behind a key gate, PII scrubbed before export
  (lib/langfuse-observability.ts, index.ts, server.ts SIGTERM flush, package.json, .env.example,
  .gitignore); Honeycomb had the infra view but not the agent/tool/model/token view.
- `c2dc554` ZT-546: AGENTS.md, no AI co-author trailers, delete langgraph.json plus the dead dev-graph
  Makefile target, and bring tasks/ current.
- PR #19 opened against dev (branch feat/langfuse-tracing-request-context), rebased onto origin/dev so
  the diff is only the 22 files these three commits touch. Verified: typecheck clean, bun test 247
  pass / 22 skip / 0 fail. NOT verified live: no Langfuse keys and no bureau or model credentials in
  the session, so the tracing gate is proven only in its OFF state. Gaps listed in the PR body.

## 2026-07-30

- `125b203` ZT-729: gate Langfuse on an explicit base URL, one session scoped trace per turn
  (lib/langfuse-observability.ts, __tests__/observability-gate.test.ts, server.ts,
  workflows/credix-workflow.ts, .env.example). Resolves the single Copilot thread on PR #19: keys
  set with LANGFUSE_BASE_URL unset would have defaulted the SDK to the public cloud host and exported
  PII there. Also lands the session/user/traceName metadata, the SIGINT flush, and the tracingContext
  forward that nests agent spans under the turn instead of a second detached trace.
- `fae50a0` infra: switch the model provider back to xAI Grok, picked from env (lib/provider.ts,
  server.ts key warning, memory/index.ts comment, .env.example, README.md). Master xai/grok-4.5,
  workers and OM xai/grok-4.20-0309-non-reasoning, both env overridable via MASTER_MODEL/WORKER_MODEL.
- Both pushed to PR #19. Copilot threads: 1 total, 0 unresolved (PR #17 was already 13/13). Verified
  before push: bunx tsc --noEmit clean, bun test 251 pass / 22 skip / 0 fail. The grok switch widens
  PR #19 beyond its ZT-729 + ZT-730 title; move it to its own branch if that matters for review.

## 2026-08-04 — PR #20: right-card flow port and prompt incorporation

Opened PR #20 against feat/langfuse-tracing-request-context (PR #19), stacked deliberately since
masterStep and the workflow are touched by both. 13 commits, 24 files.

Shipped: the persona battery (scripts/battery.ts, 21 single-turn plus 8 multi-turn cases, 5 personas,
10 deterministic checks, gitignored jsonl logs), language detection with a committed-per-session 2-vote
debounce reaching all three agents via function-valued instructions, the front-loaded CRITICAL block,
the master synthesis and compound rules, the year-one fee rule shipped inside getCardFees's result, the
grounding trio, plainSignals at both mouths that feed the model our internal taxonomy, and the handoff
plus grill-me skills ported from right-card.

Measured on two 45-turn runs against real bureau data: internal-vocab 18 to 5, glued-text 16 to 5,
announce-tool 10 to 2, repeat-sentence and dash to 0, clean p50 21.8s to 16.6s, and the CRITICAL wrong
first-year fee answer (₹29,500, joining plus annual summed) now correct at ₹14,750 with the renewal
distinction stated. no-question regressed 10 to 15 because the closing-question rule was deliberately
held out of the round to keep the number attributable; that fix and the residual vocabulary relabel are
both UNMEASURED and need the next battery.

The PR body carries the RequestContext research the user asked for: what it is (per-request Map, not
persisted, no cross-turn memory), that it costs zero tokens by itself, the three things it unlocks
(dynamic instructions, dynamic tools via DynamicArgument, tool-internal reads), measured xAI cache
behaviour including two corrections to claims I had made earlier in the session, where each kind of
context belongs, and how RAG fits (file plus one enum-keyed lookup tool, retrieved text into the message
or a tool result and never into system instructions).

Jira: NOT LINKED. Searched project ZT and found no ticket covering this; ZT-227 is the closest but it is
Shield Chat. Flagged at the top of the PR body.

## 2026-08-05 — PR #20 review round: Copilot threads resolved (e17bb3f)

Pulled the review on PR #20 (5 inline comments, 0 human: Codex 2, Copilot 3) and ran a ponytail-audit over
the 18 changed files alongside it. The audit's top findings and the Copilot threads overlapped on three
points, which is the useful signal here: an automated reviewer and a complexity audit independently landed on
the same two files.

Resolved all 3 Copilot threads in e17bb3f, each with a point-by-point reply on the thread before resolving:

1. capMapSize was not the LRU its own comment claimed. Map#set on an existing key does not move it in
   insertion order, so re-setting a live session's language every turn never refreshed its position and a
   40-turn session was as evictable as one abandoned after turn 1. sessionLanguage now sits on the repo's
   existing lib/ttl-cache.ts, which evicts expired entries before oldest-inserted, so activity is what keeps
   an entry alive. capMapSize deleted. Two bounded-map implementations became one.
2. first_year_note is quoted to the user, and it contained "Do NOT add the two together for year one" plus a
   bare 14750 with no ₹. The imperative is gone from the string (the rule already lives in
   CREDIT_CARD_ADDENDUM, which is where a model-facing instruction belongs) and the note now carries ₹ with
   Indian grouping. GST figures are derived once instead of Math.round five times, and the nested ternaries
   became firstYearNote() with flat returns, which made it unit testable: 4 new cases, including one that
   asserts no branch of the string contains an imperative, so this cannot regress quietly.
3. Comment typo, "plainened" to "made plain".

Two adjacent cleanups rode along because they were on lines already being edited: three near-duplicate money
formatters in card-catalog.ts became one module level inr(), and the en dash in the fuel waiver range became
"to", which the persona bans and the battery's own dash check flags.

Verified: tsc --noEmit clean, bun test 313 pass, 22 skip, 0 fail.

STILL OPEN on the PR, the 2 Codex threads, both tracked in tasks/todo.md: P1, the battery jsonl persists
unredacted replies and flag evidence so a leaked PAN would be written to disk (scrubIdentifiers already
exists in lib/otel.ts, apply it before the next battery run); P2, sessionLanguage is keyed by the
client-controlled session_id alone, so two mobiles sharing an id read each other's committed language.

## 2026-08-05 — PR #20 round 2: battery PII scrub and per-user language key (d030609)

A second review pass landed after e17bb3f. Copilot raised the battery log PII issue that Codex had already
filed as P1, so two reviewers converged on it independently, which made it the obvious thing to take first.
That plus Codex P2 closed the last two threads: all 6 on PR #20 are now replied to and resolved,
unresolved=0, nothing from the review outstanding.

1. The battery wrote every turn to scratchpad/ with the raw reply and the raw `flags[].evidence`. The whole
   premise of the `pii` check is that a reply CAN contain a PAN, so those were the two fields certain to hold
   a real identifier the day it fires. Every row now goes through scrubIdentifiers, the same helper the
   telemetry path uses. Gitignored was never the same as scrubbed.
   The ordering is the load-bearing part and is written into the code: the scrub sits at the DISK boundary,
   never before the checks, because a check has to see the real identifier to flag it and repeat-reply
   compares against replies held in memory. Moving it earlier would silently disable the pii check rather
   than fail a test. CIBIL scores survive, which is what keeps a graded log usable.
2. Making that testable meant the script had to become importable: main() is argv-guarded and the TEST_MOBILE
   check moved inside it, where module scope previously called process.exit(1). Worth recording how the guard
   was chosen, because the first attempt was wrong in a silent way: `import.meta.main` passed when tested with
   `bun scripts/battery.ts`, but `bun run battery` actually runs NODE plus tsx, and that property needs
   Node >= 24.2 while this repo pins no version anywhere. On an older Node the battery would have looked like
   it ran and done nothing. Now compared on argv, verified under both runners.
3. Language state is keyed `${user_id}:${session_id}`. session_id is client supplied and not unique across
   users, so the second user read the first user's committed language, and the 2-vote debounce made it stick
   for a full extra turn. Workflow memory already scopes its thread id by user_id as the resource, so this
   matches that precedent. Phase 4's sticky-routing map must use the same key.

Verified: tsc --noEmit clean, bun test 318 pass, 22 skip, 0 fail, 340 tests across 29 files.

Two lessons recorded in tasks/lessons.md: check which runtime a package script actually uses before relying
on a runtime-specific global, and scrub at the egress boundary rather than before the detector that needs the
raw text.

## 2026-08-05 — PR #20 round 3: the suppressed comments, and a root-cause miss (5c85cbd)

Worth reading even though the thread count said we were done. Copilot's review of d030609 opened with
"generated no new comments" and the thread API agreed at unresolved=0, but collapsed underneath was a
<details> block with SEVEN suppressed comments. Two of them were the SAME defect class shipped as fixed in
e17bb3f: a directive to the model sitting inside a tool-output string the agent is told to quote to the
user. e17bb3f fixed the string the reviewer named (first_year_note) instead of grepping the class, so
math_note ("so say it that way") and no_data_note ("Do NOT state an earn rate, cap or value for this
pairing") were still leaking. Both fixed now, both purely factual, and the behaviour no_data_note carried
moved into CREDIT_CARD_ADDENDUM where an instruction belongs.

The guard is the part that matters going forward: partner-math.test.ts now asserts a MODEL_DIRECTIVE
pattern against firstYearNote AND every branch of math_note, so a fourth site fails loudly rather than
shipping. It matches speech verbs rather than a bare "do not", because math_note legitimately says
"Transactions under ₹249 do not qualify", and that legitimate case is asserted in the same test so the
guard cannot be tightened into a false positive.

Also cleared from the same suppressed block: buildSignalSummary was re-implementing the relabel plainSignals
does, directly under a comment claiming one source of truth (2 of the 9 ponytail-audit items are now done);
the Hinglish marker regex was being recompiled on every request, now module scope with a test pinning
repeated calls, since the /g/ flag is only safe because String.match resets lastIndex; and CheckCtx.message
was threaded to all 10 battery checks and read by none.

Verified: tsc --noEmit clean, bun test 320 pass, 22 skip, 0 fail, 342 tests across 29 files.

Two lessons recorded: read the review BODY after every push, not just the unresolved thread count; and when
a review names one instance, derive the predicate, grep every site, and pin the predicate in a test.
