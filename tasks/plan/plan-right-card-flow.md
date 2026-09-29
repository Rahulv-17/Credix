# Plan — port the right-card FLOW into credix

Written 2026-08-04. Source studied: /home/beast/Documents/stag/right-card (sibling repo, same Mastra
stack, same xAI Grok provider, live on WhatsApp + web with real testers).
Read: part2_chat_lifecycle.md, part4_agents_and_engine.md, interface/server/index.js (the live routing
pipeline), all 5 agent prompts, lib/language-notes.ts, tasks/fix-queue.md, hallucination_audit.md.

---

## 0. The history caveat, first, because it decides the shape of everything below

credix ALREADY HAD an intent router and deliberately removed it: commit 7326317 "agents: convert
intent router to a master-worker supervisor; retire understand + score/insurance". steps/understand.ts
was a classifier plus web-grounding prefetch feeding a deterministic 4-way branch to ONE specialist.

So "put the right-card flow in credix" is, in part, reverting a decision that was made on purpose.
That does NOT make it wrong, because the two routers are not the same animal:

  credix's OLD router          right-card's router (live today)
  ----------------------          -------------------------------
  1 LLM classify call, always     regex first (microseconds, free), LLM ONLY when confidence is low
  deterministic 4-way branch      + sticky routing per thread
  no conversation state           + pending-question awareness downgrades keyword matches
  no compound handling            + compound v3 (answer primary, offer secondary)
  no language handling            + language with a 2-vote debounce
  classifier was a cost centre    classifier is a fallback, most turns never pay for it

What the supervisor bought, and what a blind port would throw away:
  - Cross-domain merge. "Which card suits my score?" needs BOTH workers and one merged answer. A
    router picks one specialist and cannot merge. This is a real product capability.
  - One less mandatory LLM hop than the old always-classify router.

=> Therefore the target is a HYBRID, not a replacement. Details in section 3.

---

## 1. What right-card's flow actually is (mechanism by mechanism)

Their pipeline lives in an Express proxy in FRONT of Mastra (interface/server/index.js). credix's
equivalent surface is the Hono server plus the workflow steps. Every mechanism below traces to a
failure they hit with live testers; the parenthetical is their own finding id or observed case.

M1. TWO-TIER INTENT RESOLUTION
    decodeMessage(text): 18 ordered regex patterns, most-specific first, returns {intent, language,
    confidence}. First match => confidence "high". No match => intent "follow_up", confidence "low".
    Only when confidence is "low" does resolveIntentWithLLM() call intentAgent (a tools-less,
    memory-less JSON classifier). Most turns cost zero extra model calls.

M2. CONTEXT-AWARE DOWNGRADE
    If the thread has a pending question (their agent's last turn ended with one) AND the new message
    is <= 8 words AND regex said "high", the confidence is FORCED to "low" so the LLM decides with the
    pending question in view. Rationale in their comment: "compare Regalia and Atlas maybe?" can just
    as easily be an answer to "which card did you mean?" as a fresh comparison ask. Long messages keep
    the fast path: a 15-word ask with a strong keyword is a genuine new request.

M3. STICKY ROUTING (their finding 3a)
    An ambiguous resolution stays with whichever agent last held the thread. Ambiguous means intent in
    {follow_up, profile_update, greeting} OR resolvedBy == regex-fallback OR confidence != "high".
    Two live failures drove this:
      - an eligibility disambiguation reply ("did you mean Regalia or Regalia Gold?" -> a bare card
        name) was classified as a fresh card_features lookup and routed to researchAgent, losing the
        in-flight eligibility flow.
      - "Yes" right after the eligibility agent asked for bureau consent classified as "greeting" at
        HIGH confidence, bounced to researchAgent, and silently derailed the whole consent flow: the
        PAN/name reply followed it, and the odds never came back because the tool never got consent.
    Hence "greeting" is unconditionally sticky even at high confidence.

M4. COMPOUND HANDLING, v3
    Only the LLM resolver sets isCompound. Their own evolution is recorded in the code:
      v1 answered one ask and silently dropped the other.
      v2 short-circuited and asked the user to re-type them separately: explicit, but it made the user
         do the machine's work, and a classifier false positive BLOCKED a legitimate single question.
      v3 (current): route by PRIMARY intent, answer it fully, and inject an instruction to end the
         reply with one line offering the secondary next. Nothing dropped, nothing blocked, and a
         false positive costs one harmless extra offer line.

M5. LANGUAGE WITH A 2-VOTE DEBOUNCE (findings 3d, 3l-i)
    Committed language per thread. Switching it, INTO or OUT OF English, needs 2 consecutive turns
    detecting the same alternate language; a single opposing turn is only a pending vote, and a return
    to the committed language clears it. A brand-new thread seeds committed = first detected language
    (before that fix, a user opening in Hindi waited 2 turns for Hindi). A regenerate does not vote.

M6. LANGUAGE REACHES EVERY AGENT VIA DYNAMIC INSTRUCTIONS (finding 3d)
    Language goes over an X-Cred-Language header -> server middleware -> requestContext -> each agent's
    `instructions: ({ requestContext }) => withLanguageNote(BASE, requestContext)`. lib/language-notes.ts
    holds one short note per language (hi, hinglish, ta, te). Originally only researchAgent read the
    signal and the other three silently ignored a non-English user.

M7. MODE SWITCH ON IDENTITY
    researchAgent's instructions are a FUNCTION of requestContext: a trusted pid (internal user) gets
    INTERNAL_INSTRUCTIONS (catalog-first, no web research); no pid gets the public web-research prompt
    with the interview flow. One agent, two prompts, chosen per request.

M8. PROFILE INJECTION INTO SPECIALISTS
    Non-research agents get researchAgent's working memory fetched over the Mastra memory API and
    prepended as a system message, so a specialist inherits what the primary agent already learned.

M9. BACKGROUND PROFILE SYNC, FIRE AND FORGET
    After each non-regenerate turn the proxy POSTs /api/profile-sync. The handler runs
    agent.generate() with structuredOutput = userProfileSchema, readOnly: true, lastMessages: 5,
    toolChoice: "none", prompt "extract any NEW profile facts from <userMessage>", then
    memory.updateWorkingMemory() with only the non-null fields (merge semantics). The client never
    waits. This is how "my income is 80k" gets learned without the agent spending its own turn on it.

M10. BOUNDED THREAD STATE
    threadAgentState (sticky agent), threadLangState (committed/pending language), threadLastQuestion
    (pending question), each capped by capMapSize(). In-process maps, not a store.

M11. CHANNEL GATEWAY TRUST
    A channel gateway that verified the sender itself (Meta verifies WhatsApp senders) may assert
    X-Cred-Verified-Mobile, proven by the shared X-Cred-Internal-Secret. A present-but-wrong secret is
    rejected outright as a spoof attempt; an absent header just means no channel-verified mobile.

M12. REGENERATE SEMANTICS
    A re-roll replays the last user message WITHOUT persisting: stored history bypassed
    (lastMessages: false), prior turns passed as reference-only `context`, readOnly so neither history
    nor the working-memory profile is mutated.

M13. STREAM TRANSLATION AND CARD DEDUPE
    Proxy translates Mastra SSE to xAI-style chunks, maps tool-calls to UI card descriptors, and
    refuses to forward the same card descriptor twice (lastCardKey).

---

## 2. credix's flow today, same granularity

  POST /v1/chat {mobile, message, channel, session_id}
    -> normalizeUserId(mobile)                          identity
    -> fetchBureau(user_id)                             single fetch, 404 => friendly not_found
    -> fetchUserStory(user_id)                          signals, enrichment only
    -> RequestContext { user_id, resourceId, channel }
    -> workflow credix-workflow, tracingOptions metadata for Langfuse
         decodeStep         STT for audio turns (NOTE: "decode" here means AUDIO, not intent)
         preGuardrailStep   injection + unsafe patterns, masks the bureau profile
         branch             !pre_guardrail -> guardrailRejectStep | pre_guardrail -> masterStep
         masterStep         masterAgent.generate, maxSteps 5, delegates to 1..N workers, synthesizes
         postGuardrailStep  strips dashes, PAN/Aadhaar/mobile from the reply
         memoryWritebackStep OM observer trigger
         composeStep        TTS for voice channels
    -> { response, session_id, active_skill, tts_failed, degraded, error_code }

What credix has that right-card does not: pre/post guardrails as workflow steps, bureau masking
before the model, OM (observational memory), TTS compose, a 120-word cap, digits-only for voice.

What credix does NOT have, mapped to the mechanisms above:
  M1 no intent resolution at all         M8 n/a (workers inherit via delegation forwarding)
  M2 no pending-question tracking        M9 partially: OM is adjacent but not a profile extractor
  M3 no routing, so no stickiness        M10 no thread state maps
  M4 no compound handling                M11 partially: INTERNAL_API_SECRET exists, no verified-mobile
  M5 no language handling                M12 no regenerate path
  M6 static instructions everywhere      M13 no streaming at all (single JSON response)
  M7 no per-request prompt mode switch

---

## 3. Target architecture: decode layer IN FRONT of a retained supervisor

Insert right-card's decode/route layer before the agent call, and let it choose between a FAST PATH
(straight to one worker, one LLM pass) and the MASTER PATH (supervisor, two passes) instead of
replacing the supervisor outright.

  POST /v1/chat
    -> identity, bureau, signals, RequestContext          [unchanged]
    -> workflow
         decodeStep (audio)                               [unchanged]
         classifyStep            NEW: regex intent + language + compound + sticky + pending-question
         preGuardrailStep                                 [unchanged]
         branch:
           !pre_guardrail            -> guardrailRejectStep      [unchanged]
           single-domain, confident  -> workerStep               NEW fast path, ONE LLM pass
           ambiguous or cross-domain -> masterStep               [unchanged supervisor]
         postGuardrail, memoryWriteback, compose          [unchanged]

Why this shape:
  - The fast path is the latency and cost fix. Today every turn pays master prompt (16k-34k tokens)
    PLUS worker prompt (11k-38k). A clear single-domain turn ("benefit of HDFC Swiggy BLCK?") needs
    exactly one of those. This is improvements.txt item 2 with a mechanism instead of a suspicion.
  - The master path keeps the capability the supervisor was introduced for. Cross-domain merges and
    genuinely ambiguous turns still get the two-pass treatment.
  - The classifier is regex-first, so the fast path does not reintroduce the old always-classify cost
    that 7326317 was partly getting rid of.
  - Sticky routing is what the old credix router lacked and what makes single-specialist routing
    survive multi-turn flows. Without M3 this port WILL reproduce right-card's consent-flow derail.

Risk to state plainly: the fast path bypasses the master, and the master's prompt is currently one of
the places persona rules are restated. postGuardrailStep (dashes, PII) is step-level and still runs, but
the 120-word cap and digits-only live in RAHUL_PERSONA, which every worker already carries. Verify per
phase rather than assuming.

---

## 4. Phased incorporation

Each phase is one commit, one verify run, and a tasks/ update in the same turn.

PHASE 0 — Baseline battery (blocking; nothing else starts until this exists)
  Port right-card's persona-battery WORKING PRACTICE, which is the part of their flow that made every
  mechanism above discoverable:
    - scripts/battery.ts: run N scripted conversations through the real /v1/chat, one session each,
      write every turn to scratchpad/battery-<date>.jsonl (message, reply, latency, active_skill,
      tool calls, trace id).
    - Personas, following theirs: expert, newbie, low-awareness, adversary, Hinglish speaker.
    - Two suites: single-turn (~20 cases) and multi-turn (~8 conversations, 3-4 turns each).
    - Grade by hand into tasks/fix-queue.md (NEW file, their convention) with a defect id per finding.
  Their 27-case run found 6 defects including a wrong fee total and internal plumbing leaked to a
  hostile user; their 34-turn run found the question-repeat defect was ENDEMIC (4 instances), not the
  one-off it looked like. credix currently has probe-turn.ts: one session, no personas, no grading,
  no log, no diffing. Everything after this phase is measured against this file.

PHASE 1 — Language, end to end (M5, M6)
  a) lib/detect-language.ts: Devanagari / Tamil / Telugu / Hinglish keyword list / default en. Pure
     function, unit-tested, no model call.
  b) lib/language-notes.ts: one note per language, ported near-verbatim (theirs is battle-tested and
     short).
  c) Thread language state with the 2-vote debounce, seeded from the first turn. credix has no
     in-process thread map yet, so this arrives with the state module in Phase 2; until then, commit
     the detector plus notes and wire the note through requestContext.
  d) persona.ts, master.ts, credit-card.ts, credix.ts: switch to
     `instructions: ({ requestContext }) => withLanguageNote(BASE, requestContext)`.
  Why first: it is the largest user-visible gap (Hinglish is the default register for our users), it
  touches no routing, and it is independently shippable.

PHASE 2 — Thread state module (M10) + pending-question tracking (M2 groundwork)
  lib/thread-state.ts: bounded maps for stickyAgent, language {committed, pending}, lastQuestion, with
  capMapSize. Set lastQuestion in postGuardrailStep (does the outgoing reply end with "?"). Read it in
  Phase 3. Single-process only, and say so in the file: a multi-instance deploy needs Redis, which we
  already run for the bureau cache.

PHASE 3 — classifyStep: regex intent + confidence (M1 tier 1, M2)
  a) lib/intent-patterns.ts: ordered patterns for OUR intents, not theirs. Ours are
     credit_card | score_improvement | bureau_query | insurance | general | small_talk, from the
     retired INTENT_VALUES constant that is still sitting in lib/patterns.ts.
  b) classifyStep between decodeStep and preGuardrailStep: returns {intent, language, confidence,
     isCompound?}. NO model call in this phase.
  c) Context-aware downgrade: pendingQuestion && wordCount <= 8 && high => low.
  d) Route only the CONFIDENT SINGLE-DOMAIN cases to a new workerStep; everything else, including
     every "low", goes to masterStep exactly as today. This makes Phase 3 strictly additive: worst
     case, nothing takes the fast path and behaviour is unchanged.
  Verify: battery diff vs Phase 0, plus the per-turn LLM-call count and token totals from Langfuse.

PHASE 4 — Sticky routing (M3)
  Ambiguous resolution stays with the agent that last held the thread. Port their exact ambiguity
  definition, including unconditional stickiness for greeting-shaped messages, and their two live
  failure cases as test fixtures: a bare card name answering a disambiguation question, and a bare
  "Yes" answering a consent-style question. credix has no consent flow yet, but it does have
  "ask before you recommend" in credit-card.ts, which is the same shape: a worker asks for monthly
  spend, the user replies "15k", and that reply must go back to the same worker.

PHASE 5 — LLM classifier fallback (M1 tier 2) + compound v3 (M4)
  a) agents/intent.ts: tools-less, memory-less classifier on WORKER_MODEL, structured output. Called
     ONLY when confidence is low. Its own prompt ports their conversation-context rule ("the input may
     begin with 'The assistant just asked: ...'; a reply answering it is follow_up at high confidence").
  b) Compound v3 verbatim in behaviour: route primary, answer fully, inject the one-line offer of the
     secondary. Skip v1 and v2 entirely; their code documents why both failed.
  Decision to make here, not before: whether the fallback classifier is worth its latency on our
  20-44s turns. If the battery shows the regex tier plus stickiness already routes cleanly, this phase
  gets deleted rather than built.

PHASE 6 — Background profile sync (M9), only if the battery justifies it
  credix has OM, which compresses history, and working memory with a schema. right-card's
  profile-sync is a separate cheap extraction with toolChoice none and readOnly. Do NOT build this on
  a hunch: check first whether OM already captures stated facts like "I spend 15k on Swiggy" well
  enough that a second extractor is redundant.

PHASE 7 — Prompt work (the earlier PR #20 plan, now downstream of the flow)
  The Tier 1-4 prompt changes from tasks/findings.md 2026-08-04 land AFTER the flow, because the flow
  determines which prompt owns which rule. Specifically, if the fast path ships, the master's synthesis
  rules matter for fewer turns, and the workers' own "no tool-call announcement" rule matters for more.

---

## 5. What NOT to port, and why

  - Their 18 intents. Ours is a coaching product with 5-6 domains, not a card catalogue with lounge and
    partner-rate intents. Port the MECHANISM, write our own patterns.
  - The 74-category spend vocabulary and the 6-step UI intake flow. credix has no picker UI and gets
    spend from the bureau, not from the user.
  - Stream translation and UI card dedupe (M13). credix returns one JSON reply; there is no stream.
    Revisit only if the interface moves to streaming.
  - Their regenerate path (M12). credix has no re-roll surface today.
  - Replacing the supervisor. See section 0.
  - Their hard out-of-scope decline. credix deliberately engages small talk and bridges to money;
    that is a product difference, not an oversight.

---

## 6. Open decisions (answer before Phase 3 lands)

  D1. Fast path scope. Start with ONE intent on the fast path (credit_card, our most common and most
      clearly single-domain) or all confident single-domain intents at once? Recommend one, measured,
      then widen.
  D2. Where classifyStep lives: a workflow step, or in the Hono handler before run.start? Recommend the
      workflow step, so it lands in the same Langfuse trace and gets the same fail-soft treatment.
  D3. Thread state store: in-process maps like theirs, or Redis (already running for the bureau cache)?
      Recommend in-process for Phase 2, with the Redis note in the file, since we are single-instance
      today and their capMapSize approach is 10 lines.
  D4. Does the fast path skip the master's persona restatement safely? Battery answers this; do not
      reason about it.
  D5. Whether Phase 5 and Phase 6 get built at all. Both are explicitly conditional on measurement.

---

## 7. Skills and working-practice gaps (the other half of "match their working")

credix .claude/skills: commit, co-review, langfuse, morning-ritual, plan, sequence, verify,
  tailored-resume-generator (unrelated to this repo, probably stray).
right-card .claude/skills: commit, gitnexus, handoff, mastra, plan, verify + frontend-only ones
  (gsap-performance, hyperframes-animation, motion-designer, ui-design, supabase*).
right-card .agents/skills: grill-me (the one used earlier in this session, which credix lacks; I
  improvised it from the name).

  S1. handoff — MISSING in credix, and .claude/rules/session-persistence.md line "If anything
      non-trivial shipped, run handoff skill" already points at it. A rule referencing a skill that
      does not exist. Port from right-card.
  S2. mastra — MISSING. Both repos are built on Mastra; right-card keeps a framework skill. credix
      instead has an MCP server for Mastra docs, which partly covers it. Port only if the MCP proves
      insufficient.
  S3. grill-me — MISSING. Port; it is 12 lines and directly useful for plan review.
  S4. tasks/fix-queue.md — MISSING as a convention. Their defect queue with per-defect ids, severity,
      root cause, and the fix location. credix has improvements.txt (created 2026-08-03) which is
      the same idea for architecture-level items; fix-queue is for per-reply defects from batteries.
  S5. scratchpad/*.jsonl reply logs — MISSING. Their graded battery logs are what make "endemic vs
      one-off" answerable. Comes with Phase 0.
  S6. Their eval-doc-driven prompt templates (commit e3c038d) and reply-exemplars.md. Consider after
      Phase 0 produces our own defect list; exemplars written from OUR failures beat ported ones.
