# Fix queue — per-reply defects from persona batteries

Convention ported from ../right-card/tasks/fix-queue.md. One entry per observed defect, with the
evidence verbatim, the root cause when known, and WHERE the fix lands. Distinct from
tasks/improvements.txt, which holds architecture-level items.

Severity: CRITICAL = wrong money/eligibility answer a user could act on. HIGH = leaks internals, PII,
or breaks a stated persona rule. MEDIUM = degrades the reply. LOW = cosmetic.

Status values: open | fixed <commit> | wontfix <reason>

---

## Battery: baseline, 2026-08-04 (stamp base0804) — pre-flow-port, pre-prompt-work

Runner: `bun run battery` (src/mastra/scripts/battery.ts), 21 single-turn + 8 multi-turn cases across
5 personas, real /v1/chat with TEST_MOBILE. Log: scratchpad/battery-base0804.jsonl (gitignored).
Confound to remember when comparing runs: every case uses the same TEST_MOBILE, so conversation memory
is isolated per case (fresh session_id) but RESOURCE-scoped working memory persists across cases.

### D1. First-year card fee double-counted — CRITICAL, confirmed wrong answer
- Case E1/E2 (expert). "Total first year cost of HDFC Infinia including GST?"
- Reply: "**₹29,500** total in year 1 for HDFC Infinia, GST included. That is joining fee ₹14,750 plus
  annual fee ₹14,750."
- This is right-card's F1 defect reproduced exactly, same card family and same number. Their verified
  finding: joining and annual are NOT additive in year one; year-one cost is the joining/first-year fee
  only, and the annual fee applies from renewal (year 2).
- Root cause to confirm: does the card catalog expose a `first_year_fee` column the way right-card's
  does, and does getCardFees surface it? If the field exists, this is narration; if it does not, the
  tool cannot express the right answer and the fix is partly in the catalog layer.
- Fix lands in: tools/card-catalog.ts (getCardFees output shape or its toModelOutput guidance) AND a
  CREDIT_CARD_ADDENDUM rule. Prompt alone is not enough if the data cannot express year one.
- NOT caught by any automated check — it is semantic. Recorded here because the ported `watch` note on
  the case is what made a human look.
- Status: open

### D2. Tool-call announcement, then glued text — HIGH, and it is the flow defect
- Case E1 (expert). "What is my current utilisation and which account is dragging it up?"
- Reply opened: "I will check your utilisation details now.Your credit utilisation ... sits at 28%."
- Two defects in one line: a narration sentence that should never be written, and no space at the join
  ("w.Yo"), which is the master concatenating its own preamble with worker text rather than
  synthesizing one reply. Same class as the 2026-08-03 probe ("you.HDFC", "spends.Quick").
- Fix lands in: MASTER_ADDENDUM (no preamble, rewrite rather than append) and the persona CRITICAL
  block ("never announce a tool call"), i.e. flow-port Phase 7 Tier 1.
- Checks that catch it: `announce-tool`, `glued-text`.
- Status: open

### D3. Internal term "net value" reached the user — HIGH
- Case E3 (expert). Reply: "here is the net value picture ... Net value near ₹17,000."
- right-card forbids this exact phrase to users, alongside income floor / score floor / bucket / NTC,
  because it is internal ranking vocabulary. credix has no jargon ban list at all.
- Fix lands in: persona CRITICAL block, jargon ban list (Phase 7 Tier 1).
- Check that catches it: `internal-vocab`.
- Status: open

### Baseline run, graded: 45 turns, 18.0 min, all HTTP 200, zero degraded, zero PII flags

Latency: min 3.2s, p50 21.8s, p90 37.5s, MAX 89.1s, mean 24.0s.
Flag counts: spelled-number 19 (noisy by design), internal-vocab 18, glued-text 16, no-question 10,
announce-tool 10, over-length 6, repeat-sentence 2, dash 1, pii 0.

### D4. Master narrates a plan, then glues worker text onto it — HIGH, ENDEMIC (16 of 45 turns, 36%)
- Not the one-off it looked like on 2026-08-03. Sixteen turns across every persona: E4, N3, N4, L2, L3,
  L4, H3, S2.2, S2.3, S3.3, S4.1, S4.2, S5.2, S7.1, S7.2, S7.3.
- Verbatim, S4.1: "I'll find a good fit for you. Checking cards that match your spends and
  profile.Bhai, with 15 cards already, money tight..." The narration is the master's; the answer after
  the missing space is the worker's.
- S3.3: "Got it, food delivery and fuel are your main spends. I'll factor that in.Got it, food delivery
  and fuel are your big ones." The SAME acknowledgement twice, once from each pass.
- This is right-card's M2 ("question-repeat / glued-text is ENDEMIC, not one-off") reproduced in our
  supervisor. Their conclusion applies: it must become a general rule for all agents, not a patch.
- Fix lands in: MASTER_ADDENDUM (never narrate the plan, rewrite worker output rather than append) and
  the persona CRITICAL block. Phase 7 Tier 1, now the highest-value prompt change we have.
- Status: open

### D5. "thick file" and other internal taxonomy reach the user — MEDIUM (18 turns)
- Word counts across the run: "thick file" 13, "prime segment" 2, "foir" 1, "net value" 1,
  "database" 1.
- Nuance the raw count hides: H1 actually GLOSSED it, "teri thick file (lambi credit history)", which
  is the persona's explain-jargon rule working. The defect is using our internal signal vocabulary as
  the user-facing noun at all, not the absence of a gloss.
- "database" (1 turn) is the one that matters most: that is plumbing, and right-card's F6 was exactly
  this leaking to a hostile user.
- Fix lands in: persona jargon ban list with plain-language replacements ("a long credit history",
  not "a thick file"). Phase 7 Tier 1.
- Status: open

### D6. Language is mirrored inconsistently, sometimes inside ONE reply — HIGH
- This is the finding that makes Phase 1 worth more than "we had no language handling".
- H1 ("mera credit score kaisa hai bhai?") replied fully in Hinglish, unprompted: "Bhai, tera credit
  score 791 hai."
- H2 ("swiggy ke liye best card kaunsa hai, monthly 15k kharch hota hai") replied entirely in ENGLISH.
- S4.1 mixed BOTH in one reply: an English narration sentence, then Hinglish content.
- So the model mirrors the register when it feels like it. The defect is inconsistency, and a committed
  session language (Phase 1, commit 1468900) is the fix; the debounce is what stops it flapping.
- Status: fixed 1468900, pending an after-battery to confirm

### D7. Compound asks are over-served, not dropped — MEDIUM (correction to my own prediction)
- The case note on S7 predicted "expect one dropped". Wrong. S7.1 ("how does credit utilisation work,
  and also which card suits my score?") answered BOTH parts, at 69.5 seconds and over the word cap.
- Consequence for the plan: compound v3's value for credix is LENGTH and LATENCY control, not drop
  prevention. Phase 5 keeps its place but its justification changes.
- Status: open

### D8. 89 second worst-case turn — HIGH, and the numbers now exist
- p50 21.8s, p90 37.5s, max 89.1s over 45 real turns. S7.1 alone was 69.5s.
- improvements.txt item 2 said the composition was unattributed. It still is, but the distribution is
  now measured, and the two worst turns are both multi-part asks that fan out to several tool calls.
- Fix candidates in order: the fast path (Phase 3, skips the master's second pass), then compound v3
  (Phase 5, stops one turn answering two questions), then tool subsetting.
- Status: open

### D9. Ten turns ended without a question — MEDIUM
- Both repos require ending on one focused next step. 10 of 45 replies contain no question at all,
  including H1, which otherwise reads well.
- right-card's answer is a lookup table of "just answered X, good next question", 9 rows. Ours would be
  shorter: profile review, score improvement, card pick, fee question, small talk.
- Fix lands in: persona, Phase 7 Tier 4 (measure first: this may resolve once the master stops
  narrating and has room inside the word cap).
- Status: open

---

## Automated checks in the runner, and what they cannot see

`pii`, `announce-tool`, `glued-text`, `internal-vocab`, `dash`, `over-length`, `repeat-sentence`,
`repeat-reply`, `no-question`, `spelled-number`.

Known blind spots, all requiring a human read of the jsonl:
- arithmetic and fee-composition errors (D1 is the proof)
- an answer that is fluent, well formatted, and about the wrong card
- a reply that silently drops one of two asks (compound)
- ranking that contradicts the reward math two turns later (right-card M4)
`spelled-number` is deliberately noisy: "one question", "one line" trip it legitimately.


---

## Battery: after Phase A, 2026-08-04 (stamp afterA0804) — A1-A6 + A8 applied

Same 45 cases, same TEST_MOBILE, same runner. Log: scratchpad/battery-afterA0804.jsonl.

  check             before  after   delta
  internal-vocab        18      5     -13
  glued-text            16      5     -11
  announce-tool         10      2      -8
  over-length            6      3      -3
  repeat-sentence        2      0      -2
  dash                   1      0      -1
  no-question           10     15      +5   <-- REGRESSION, see D9 below
  spelled-number        19     15      -4   (noisy check, ignore)

Latency: clean p50 16.6s (was 21.8s). NOT comparable at the tail: 6 upstream retry events
("[agent:master] attempt N/3 failed") pushed 5 turns past 60s, max 324s. The battery was hammering xAI
hard enough to get throttled, so treat the after-run's p90/max as contaminated, not as a regression.

### D1 — FIXED, verified (A5, commit 27e0ce7)
E2 now: "**₹12,500** plus 18% GST makes the total first year cost **₹14,750**. That is only the joining
fee. The same amount as annual fee is charged from year 2 onward." Correct, and it cites the tool's own
first_year_note rather than doing the arithmetic. Status: fixed 27e0ce7

### D4 — LARGELY FIXED (A3, commit dc093b0). 16 -> 5 glued-text, 10 -> 2 announce-tool.
Residual 5 are the same shape at lower frequency, e.g. S3.3 "Noting food delivery and fuel as the main
spends, then getting a tight cash-flow plus card fit take.Food delivery and fuel are eating..." So the
rule works but is not absolute. Do NOT add a second prompt rule for the remainder: right-card's 7d6cb0c
lesson says a rule that must always hold belongs in code. A deterministic post-processor in
postGuardrailStep (strip a leading narration sentence when the next sentence starts mid-flow) is the
candidate, and it is Phase 5 of the flow plan's open question. Status: open, downgraded to MEDIUM

### D5 — LARGELY FIXED (A1, commit ac2141b). 18 -> 5.
Residual traced to a SECOND mouth feeding the same words: 4 of the 5 were "thick file" on turns that
called getSignals and read the raw payload, and 1 was "income floor", which was in our own
CREDIT_CARD_ADDENDUM text. Both fixed by relabelling at the tool boundary (plainSignals in
lib/signal-summary.ts, applied in tools/signals.ts) and rewording the addendum. Unmeasured: needs the
next battery. Status: fixed pending measurement

### D9 — REGRESSED then addressed (A7)
10 -> 15 replies with no closing question. Cause is legible BECAUSE A7 was deliberately held back from
this round: A2 and A3 told the master to be terse and start with the answer, and it complied by also
dropping the closing question. A7 (one focused closing question, with four worked pairs) is therefore a
measured fix rather than a guess. Unmeasured: needs the next battery. Status: fix applied, pending
measurement

### PRUNE DECISIONS (the discipline this loop exists for)
- KEEP A1, A2, A3, A4, A5: every one moved its target number.
- KEEP A6 (in-generation tool check) despite being unmeasurable by the regex checks: right-card's F1 and
  F2 were both this class, and the failure mode is a wrong money answer. The other two rules in A6
  (per-card comparison data, self-contradiction) stay for one more round; if the next hand-grade finds no
  instance they get deleted.
- NOTHING to delete this round. No rule failed to move its number except A7, which was not in the round.


---

## End-to-end GOAL test, 2026-08-04, session goal-e2e-0804 (3 turns, one journey)

Different instrument from the battery: the battery checks reply hygiene per turn, this asks whether the
user's actual goal is met across a journey. Criteria were written BEFORE the run. Goal: a user with real
bureau data wants a card they can act on, and their approval odds. 1 of 5 criteria passed cleanly.

### D10. Invented approval percentages — CRITICAL, and no check catches it
- Turn 3 answered "Around **40%** for HDFC Swiggy ORNGE right now" and "can lift odds toward **65%** in
  2 to 3 months".
- checkCardEligibility (tools/eligibility.ts) returns a TIER: premium | standard | secured. It has never
  returned a probability. Those percentages are fabricated, bolded, and attached to an approval question.
- Violates two persona rules at once: never invent a number, and describe odds rather than promise.
- Same blind spot class as D1: semantic, so no regex check sees it. Only a human reading the reply.
- Fix: an explicit rule that approval is a tier and a direction, never a percentage, plus a check that
  flags a bolded percentage next to approval or odds language.
- Status: open

### D11. Named a card without asking for the missing input — HIGH
- Turn 1 ("I want a new credit card, which one should I get?") never asked for spend mix. It advised
  holding off, then named HDFC Swiggy ORNGE anyway.
- CREDIT_CARD_ADDENDUM already says: "you need monthly spend, top 1 or 2 spend categories, and flights
  per year. Ask for whichever is missing, in one short question, before naming cards."
- The protective advice itself was sound for this profile (₹15,000 take-home, 15 open cards, heavy EMIs).
  The defect is answering a different question than the one asked while also breaking the ask-first rule.
  right-card's rule for this shape: "a direct request always wins over an earlier stance".
- Status: open

### D12. The same closing question three times, reworded — MEDIUM
- "Want me to map the one balance payoff that frees the most breathing room this month?" then "Want the
  one payoff step that drops utilisation the quickest?" then "Want a simple payoff order that hits those
  numbers fastest?"
- right-card's rule is "ask each question exactly ONCE per message, never reworded". Our repeat-reply
  check only catches IDENTICAL replies, so a reworded repeat passes.
- Fix: extend the check to compare closing questions across turns in a session, by keyword overlap.
- Status: open

### D13. The jargon leak survives in PERSISTED MEMORY, and my earlier attribution was wrong
- CORRECTION to the after-battery note: I attributed the residual "thick file" to getSignals returning
  the raw payload, and fixed that (A1b). The dominant source is actually WORKING MEMORY. The stored
  prose_summary reads "User is in the prime segment with a thick file and multiple properties", written
  by updateWorkingMemory in an earlier session BEFORE the relabel, and the OM Observer re-summarises it
  forward every turn.
- Evidence: in the turn-3 trace, "thick" appears 57 times in observation INPUTS (we feed it) and the new
  wording "long credit history" appears 149 times, so plainSignals IS working on fresh injections.
- The general lesson: a vocabulary fix does not retroactively clean persisted memory, and OM propagates
  its own old phrasing. Any future relabel needs a migration or a read-time scrub, not just a fix at the
  write site.
- Fix options: clear or migrate stored working memory for affected resources; scrub on read; or add the
  words back to the CRITICAL ban list so the model does not repeat what memory hands it.
- Status: open

### D14. Bad-income guard misses the boundary — MEDIUM
- CREDIX_ADDENDUM says an income "under ₹15,000 a month" is likely a bad bureau read and must not be
  quoted or used in derived numbers. This profile reads EXACTLY ₹15,000, so the guard did not fire, and
  turn 3 computed approval odds off it ("HDFC typically wants ₹20,000 monthly income and you have
  ₹15,000") for a user with ₹18,23,700 outstanding across 15 cards, which is exactly the implausible
  combination the guard exists to catch.
- Fix: make the threshold inclusive, or better, gate on the implausibility (income low AND large
  outstanding or many accounts) rather than on a single number.
- Status: open

### What the goal test proves about the battery
The battery would have PASSED most of this journey: turn 3 had no announce-tool, no over-length, no PII,
and ended with a question. It would not have noticed a fabricated 40%, a card named without asking, or
the same question asked three ways. Hygiene checks and goal checks are different instruments and we need
both. The goal test costs 3 turns and a human read; run one per session.


---

## Merchant level verification, 2026-08-05 (session merchant-math-verify-0804)

Ran the merchant maths fix (3f358c4) end to end rather than trusting the unit tests. The tool layer was
correct; the end to end run found a defect the unit tests could not see, which is why the run mattered.

### D15. Empty tool result, so the model invented the cap — CRITICAL
- Question: "which card is best for swiggy? i spend around 15000 a month there".
- Reply: "5% back as statement credit, capped at ₹750 a month, so that is ₹750 every month or about
  ₹9,000 a year."
- Trace evidence: getCardPartnerRates was called correctly WITH monthly_spend 15000 and returned an
  EMPTY result (148 bytes) because neither Swiggy card has a card_partner_rate row for swiggy. The only
  place the 5% and the ₹750 cap appear anywhere in the trace is the worker's own output text. The two
  other "750" hits in the trace are a late payment fee slab and the CIBIL score, both unrelated.
- Ground truth: the real data is in card_category, hdfc_swiggy_orange / online_food = 5% with a ₹1,500
  cap and a ₹249 minimum transaction. So the RATE was right by luck, the CAP was invented, and the
  ₹750 monthly figure was right only because 5% of 15,000 happens to equal 750. A user planning to spend
  more would have been told a ceiling that does not exist: the real one is ₹1,500, worth ₹30,000 of spend.
- Root cause, and it generalises: an empty tool result is silence, and the model fills silence from
  memory. The addendum had a rule for a NULL FIELD on a returned card and no rule for ZERO ROWS.
- Fixed by two changes:
  1. tools/card-catalog.ts categoryFallback: catalog.partner maps a merchant to a spend category
     (43 of 61 partners carry one, swiggy -> online_food), so when no negotiated rate exists the tool now
     returns the card's category rate, labelled source=category_rate with category_code, and runs the same
     maths. Rows also carry rewards_excluded, so a category that earns nothing says so.
  2. A no_data_note on the output when even that finds nothing, in words the model can repeat, plus an
     addendum rule that zero rows is not a null field and must never be filled from memory.
- Verified after the fix, same question end to end: "5% back as statement credit, so about ₹750 a month
  or ₹9,000 a year (after the ₹249 per transaction minimum)". The invented cap is gone and the ₹249
  minimum is information no tool could supply before. Swiggy BLCK (₹1,500, its real 10% cap binding) and
  Axis ACE (₹500) are also correct. At ₹40,000 spend the tool now reports the real ₹1,500 cap binding with
  ₹10,000 of spend earning nothing, which the invented ₹750 ceiling had hidden entirely.
- Status: fixed, this commit

### Partial compliance worth watching
The reply did not say "this is the card's rate for the whole online food category, not a Swiggy specific
deal", even though math_note carries that sentence and the addendum now asks for it. Nothing it said was
wrong, so this is a phrasing gap rather than a defect. If it recurs, the provenance belongs in the
sentence the model copies rather than in a trailing clause.

### What this says about the instruments, again
The 8 unit tests passed and the tool was correct in isolation. Only a live turn exposed the empty result
path, and only a trace read proved the figure was not tool sourced. Neither the regex battery nor the
unit tests could have caught it: the reply was fluent, correctly formatted, ended with a question, and
its arithmetic was internally consistent. Third instance now of the same lesson, after D1 and D10.
