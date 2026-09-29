# Plan — incorporate right-card's agent instruction patterns into credix

Written 2026-08-04. Phase 7 of tasks/plan/plan-right-card-flow.md, brought forward and split.
Sources: tasks/findings.md (2026-08-04 prompt study), tasks/fix-queue.md (D1-D9, baseline battery),
../right-card agent prompts + commit history.

RULE FOR THIS WHOLE PLAN: every rule added must trace to a defect measured in battery-base0804 or to a
right-card commit that fixed one. A rule that moves no flag count in the after-battery gets DELETED, not
kept "just in case". That prune loop is what produced their 25 prompt commits.

BASELINE TO BEAT (scratchpad/battery-base0804.jsonl, 45 turns):
  glued-text 16 | internal-vocab 18 | announce-tool 10 | no-question 10 | over-length 6
  repeat-sentence 2 | dash 1 | pii 0 | latency p50 21.8s p90 37.5s max 89.1s
  plus D1, a CRITICAL wrong answer that no automated check catches.

---

## Step 0 — Root-cause check before any prompt edit (DONE, and it changed the plan)

Finding: `lib/signal-summary.ts:24-27` pushes `segment ${signals.segment}` and `${signals.file_tier}
file` straight into the master prompt. So "prime segment" (2 turns) and "thick file" (13 turns) are the
model ECHOING ITS INPUT, not inventing vocabulary. 15 of the 18 internal-vocab flags are ours.

Consequence: D5 is mostly a CODE fix, not a prompt rule. A prompt rule banning a word we supply in the
same prompt is fighting itself, which is right-card's 7d6cb0c lesson ("prompt rules lost to prompt
templates") in reverse. Only the residual words that do NOT come from injected data (catalog, database,
net value, FOIR) belong in a prompt ban list.

Lesson for the rest of this plan: for each defect, ask FIRST whether we are feeding it.

---

## Phase A — flow-independent (can land now, no dependency on classifyStep)

### A1. Relabel the injected signal summary          [CODE, fixes ~15 of 18 internal-vocab]
- File: `lib/signal-summary.ts`
- Change: emit plain language instead of internal taxonomy. `thick file` -> `long credit history`,
  `thin file` -> `short credit history`, `segment prime` -> `strong score band`. Keep the terse shape;
  this is a relabel, not a redesign.
- Check: `lib/signal-summary.test.ts` already exists; extend it to assert the internal words are absent
  from the built summary.
- Cost: zero prompt tokens. Deterministic. Cannot be ignored by the model.

### A2. Front-load a CRITICAL block in the shared persona   [PROMPT, fixes D4, announce-tool, over-length, dash, D9]
- File: `agents/persona.ts`
- Change: add a `## CRITICAL — never break these. Detail follows below.` block of at most 8 lines at the
  TOP, then keep the existing rules below it as the detail. Per right-card bd977f8: ordering, not
  completeness, is what makes rules hold.
- Contents, each line traceable to a flag:
    never announce or narrate what you are about to do      (announce-tool 10)
    one reply per turn, one voice, never paste another agent's words   (glued-text 16)
    digits only; ₹ Indian grouping; % on rates              (spelled-number, existing rule moved up)
    no dashes as punctuation                                (dash 1, existing rule moved up)
    never PAN / Aadhaar / full mobile                       (pii 0 today, keep it that way)
    never invent a number; if it is not in the profile or a tool result, say so
    120 words, 200 only for an explicit full card rundown   (over-length 6, existing rule moved up)
    residual jargon ban: catalog, database, net value, FOIR (the 3 of 18 not fixed by A1)
- Token cost: ~200 tokens, static, and measured 98% cached after the first turn (findings.md
  2026-08-04), so it bills at the cached rate. Affordable precisely because it is static.

### A3. Master synthesis rules                        [PROMPT, fixes D4 — the endemic one]
- File: `agents/master.ts` MASTER_ADDENDUM
- Change: three rules the current addendum lacks. It says "synthesize ONE reply" but never forbids
  narrating the plan or appending worker text.
    - Do not write a sentence about what you are about to do. Start with the answer.
    - Rewrite what the workers return in your own voice. Never append their text to yours, and never
      repeat an acknowledgement a worker already made. (Evidence: S3.3 said "Got it, food delivery and
      fuel are your main spends" twice, once per pass.)
    - The user must never be able to tell how many workers ran.
- This is the highest-value single change in the plan: 16 of 45 turns.

### A4. Compound asks, v3 in prompt form              [PROMPT, fixes D7]
- File: `agents/master.ts` MASTER_ADDENDUM
- Change: one rule. If the message contains two genuinely distinct asks, answer the PRIMARY one fully
  and end with one short line offering the second.
- Why this is cheap for us: right-card needed an LLM classifier for compound because their router picks
  ONE agent and never sees the whole message again. Our master already sees it. So we get their v3
  behaviour for one line, and Phase 5's classifier loses most of its justification.
- Evidence: S7.1 answered both parts in 69.5s over the word cap.

### A5. Year-one fee composition                      [DATA + TOOL + PROMPT, fixes D1 CRITICAL]
- Blocking check first: does the card catalog expose a first-year/joining fee distinct from annual?
  `grep -n "first_year\|joining" src/mastra/tools/card-catalog.ts lib/catalog-*.ts`. If the column does
  not exist, the tool CANNOT express the right answer and this step is partly a data-layer task; say so
  rather than papering over it with a prompt rule.
- If the data exists: add a `first_year_note` to `getCardFees`'s returned object, e.g. "Year one is the
  joining fee plus GST only; the annual fee applies from renewal." The rule then arrives WITH the
  numbers on the turn it is needed (right-card 7d6cb0c), where a prompt rule can be skipped.
- Plus one CREDIT_CARD_ADDENDUM line: never add joining and annual together for year one.

### A6. Grounding trio                               [PROMPT, hallucination_audit H1]
- File: `agents/credit-card.ts` CREDIT_CARD_ADDENDUM
- Three rules, ported and adapted:
    in-generation check: about to write a rate, fee or figure with no tool call THIS turn, stop and call
      the tool. Prior-turn context is not a substitute.
    comparisons need this-turn data for EVERY card; one card's tool call does not license the other's.
    if two of your own numbers disagree, re-derive from the tool result instead of publishing both.
- Note: no battery flag catches these, because they are semantic. They are here on right-card's
  evidence (their F1/F2 were both this class), not ours. If the after-battery cannot show they help,
  they stay only if a hand-graded case shows the failure.

### A7. Closing-question rule                         [PROMPT, fixes D9]
- File: `agents/persona.ts`
- Change: end every substantive reply with ONE focused question specific to what was just discussed,
  never a generic "anything else". Include 4 short worked pairs, not right-card's 9-row table (ours has
  fewer domains): profile review, score improvement, card pick, fee question.
- Sequencing note: try this LAST within Phase A. D9 may partly resolve once the master stops burning
  words on narration and has room inside the 120-word cap.

### A8. Pin the new invariants                        [TEST]
- File: `__tests__/agents.test.ts`
- Assert the CRITICAL lines exist verbatim in all three agents' resolved instructions, so a later edit
  cannot quietly drop them. right-card's 5ab422f is literally them repairing this kind of drift.

### A9. After-battery and PRUNE                       [MEASUREMENT, gates the commit]
- Run `bun run battery` (same 45 cases, new stamp), diff every flag count against base0804, append the
  comparison to tasks/fix-queue.md.
- Then prune: any rule from A2-A7 whose target flag did not move gets deleted in the same commit that
  reports the numbers. This is the step that keeps the prompt from growing monotonically.
- Also record latency p50/p90/max: A3 and A4 should reduce tokens per turn, so if latency does not
  improve at all that is itself a finding.

---

## Phase B — flow-dependent (blocked on Phase 3's classifyStep)

### B1. Move the two `Situations:` sections into intent-keyed blocks
- Files: `agents/credit-card.ts`, `agents/credix.ts`, plus a new `agents/situations.ts`
- Both addenda carry a `Situations:` section (~15 lines each) where exactly ONE situation applies per
  turn. Once `requestContext.get('intent')` exists, append only the matching block.
- Expected effect: a straight reduction in tokens paid per turn, not a redistribution. But see the
  caching finding: static text bills at the cached rate, so the saving is smaller than it looks. Justify
  B1 on attention (a shorter prompt the model actually follows), and verify with the battery.

### B2. Consider per-intent tool subsetting
- Measured 2026-08-04: 9 tool schemas are ~585 tokens, already cached, so this saves ~$0.0001/turn.
  Justify ONLY on decision quality (12 tool choices vs 3), never on tokens. Optional, and last.

---

## What we deliberately do NOT port

- Their 712-line prompt wholesale. The bulk is a 74-category spend vocabulary and a 6-step picker intake
  flow that credix has no equivalent of.
- Their 18 intents (we have 5-6 domains), their `show-*` UI tools, their invite-only first-card rules.
- Their hard out-of-scope decline: credix deliberately engages small talk and bridges to money.
- Their eligibility consent flow: we have no bureau-consent surface.

## Open decisions

1. A5 is blocked on the catalog column check. If `first_year_fee` does not exist, is fixing the catalog
   in scope for this PR, or does D1 get a prompt-only mitigation plus a data-layer follow-up?
2. A7 before or after measuring A2-A4 (recommend after, it may self-resolve).
3. Do A6's semantic rules stay if the battery cannot measure them? Recommend yes for the in-generation
   check (right-card's F1/F2 evidence is strong and the failure is a wrong money answer), and drop the
   other two if unmeasurable.

## Commit shape

One commit per step A1..A8, then A9 as the measurement-and-prune commit. Each commit updates
tasks/fix-queue.md status for the defects it claims to fix. Standard verify (tsc + bun test) each time;
the after-battery only once, at A9, since it costs 18 minutes and real tokens.
