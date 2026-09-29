# Credix — User Setup Turn 1: End-to-End Node Documentation

This document describes the **Turn 1** request pipeline node by node, from the moment a
user query arrives to the moment a response is delivered. It leads with implementation
**progress**, then documents each node in full.

> Scope note: Identity Check and the Raw Data Layer (bureau fetch) run **once, at the API
> boundary, before the workflow starts** (the single-fetch rule). Everything from Decode
> onward runs inside the orchestrated workflow.

---

## 1. Tag legend

| Tag | Meaning |
|-----|---------|
| LLM | Node makes a large language model call |
| Tool | Node performs a tool call / external lookup |
| Raw Data | Node reads or serves the raw data layer |
| Deterministic | Pure code, no LLM and no external model |

## 2. Status legend

| Status | Meaning |
|--------|---------|
| Done | Implemented and exercised by tests / live run |
| Partial | Core path works; documented gaps remain |
| Planned | Placeholder exists; behaviour deferred to a later phase |

---

## 3. Progress at a glance

| # | Node | Tag | Status | One-line state |
|---|------|-----|--------|----------------|
| 0a | Identity Check | Tool | Done | Normalises mobile to a 10-digit id; verifies a bureau record exists; never throws |
| 0b | Raw Data Layer (bureau) | Raw Data | Done | One read-through fetch: cache → document store → warehouse; PII stripped on the way out |
| 1 | Decode | Deterministic | Partial | Text + voice (speech to text) + language detection done; document input not yet wired |
| 2 | Understand | LLM | Done | Intent classification + request brief; safe fallback to `general` on model failure |
| 3 | Pre-Guardrail | Deterministic | Done | Scope + injection screen; PII partial-masking; only safe sections forwarded |
| 4 | User Story Creation | LLM | Planned | Placeholder step; narrative build deferred (depends on the memory store) |
| 5 | Agent / Skill Resolver | LLM | Done | Routes the intent to one specialist branch (or the guardrail-reject branch) |
| 6 | Skill / Specialized Agent | LLM Tool | Done | Four specialists; bounded tool calls; per-user memory thread |
| 7 | Post-Guardrail | Deterministic | Partial | Scrubs PAN / Aadhaar / mobile from the reply; numeric re-trace is basic |
| 8 | Update Memory / User Data | LLM | Planned | No-op pass-through today; async working-memory persistence deferred |
| 9 | Compose | Deterministic | Done | Channel formatting for WhatsApp, web, and text-to-speech |

**Headline:** the happy path is wired end to end and runs live (real model + real bureau).
Two nodes are deliberate placeholders (**User Story Creation**, **Update Memory**), both
waiting on the persistent memory store, and two have small documented gaps (**Decode**
document input, **Post-Guardrail** numeric re-trace).

### Phase rollup

| Phase | Nodes | Status |
|-------|-------|--------|
| Ingress (identity + data) | Identity Check, Raw Data Layer | Done |
| Understanding | Decode, Understand | Mostly done |
| Safety in | Pre-Guardrail | Done |
| Personalisation | User Story Creation | Planned |
| Reasoning | Skill Resolver, Specialized Agent | Done |
| Safety out | Post-Guardrail | Mostly done |
| Persistence + delivery | Update Memory, Compose | Compose done, memory planned |

---

## 4. Pipeline order

The live order differs slightly from the diagram: the guardrail runs **before** Understand
(cheap screen before any model call), and Identity + bureau happen **before** the workflow.

| Step | Node | Runs where |
|------|------|------------|
| 1 | Identity Check | API boundary (pre-workflow) |
| 2 | Raw Data Layer fetch | API boundary (pre-workflow) |
| 3 | Decode | Workflow |
| 4 | Pre-Guardrail | Workflow |
| 5 | Understand | Workflow |
| 6 | Branch: Skill Resolver → Specialized Agent (or Guardrail-Reject) | Workflow |
| 7 | Post-Guardrail | Workflow |
| 8 | Update Memory | Workflow |
| 9 | Compose | Workflow |

---

## 5. Node-by-node

### 0a. Identity Check — Tool — Done

- **Purpose:** turn whatever the user typed as a phone number into the single canonical
  10-digit `user_id` used across every layer, and confirm the person has a bureau record.
- **Inputs:** raw mobile string (may carry `+91`, spaces, a leading `0`).
- **Outputs:** `user_id` + `identity_verified` flag, or an error code.
- **Behaviour (points):**
  - Accepts only a bare 10-digit number, optionally with a recognised trunk/country prefix;
    arbitrary overlong input is **rejected**, never truncated, so two inputs can't collapse
    to the same user.
  - Verification is a lookup against the data layer; a true miss returns "not found", an
    infrastructure failure returns "unavailable" — the two are never conflated.
  - **Never throws.** A failure returns `identity_verified: false` with a reason, so the API
    can answer cleanly instead of 500-ing.

| Outcome | Response |
|---------|----------|
| Valid + record found | Proceed to workflow |
| Malformed number | 400, "invalid mobile number format" |
| No record | Friendly "use your registered bank mobile number" |
| Data layer down | 502, sidecar unavailable |

### 0b. Raw Data Layer (bureau) — Raw Data — Done

- **Purpose:** serve the user's full bureau profile (~321 variables) once per request.
- **Read-through tiers:**

| Tier | Store | Holds | Freshness |
|------|-------|-------|-----------|
| L1 | Key-value cache | PII-stripped profile, one JSON blob per user | TTL bound |
| L2 | Document store | Full profile incl. PII (the audit record) | Served if within the freshness window |
| L3 | Warehouse | Source of truth | Re-fetched on miss / stale / schema change |

- **Behaviour (points):**
  - A per-user lock prevents a cache miss from stampeding the warehouse.
  - All PII lives under one block; it is stripped before the profile reaches any caller and
    is **never** written to the L1 cache. Only the document store keeps the full record.
  - Sections (`general_info`, `loan_details`, `enquiries`, `dpd`, …) are addressable so a
    caller can pull one slice instead of the whole profile.
  - Backend-portable: the cache speaks a plain key-value subset, so it runs unchanged on
    Pogocache, Redis, or Valkey.

### 1. Decode — Deterministic — Partial

- **Purpose:** turn whatever modality arrived into normalised text plus a detected language.
- **Done:**
  - Text passthrough.
  - Voice: audio MIME handling for the common formats (mp3, wav, ogg, m4a, flac, webm, aac,
    opus) routed to speech-to-text.
  - Language detection by script range (Hindi, Gujarati, Bengali, Tamil, …) with a default.
- **Gap:** document input (the "Doc" path in the diagram) is not yet wired.

| Input | Output |
|-------|--------|
| Text / audio / (doc, planned) | `{ text, language }` |

### 2. Understand — LLM — Done

- **Purpose:** classify the request into exactly one intent and decompose it into a brief the
  specialist can act on.
- **Intents:** `bureau_query`, `score_improvement`, `credit_card`, `insurance`, `general`.
- **Brief:** a one-sentence summary plus 2–5 concrete sub-points the specialist should cover.
- **Resilience (points):**
  - On a model error or timeout it **degrades to `general`** rather than failing the turn.
  - The intent string is what the downstream branch routes on, so this node is the routing
    authority for the whole turn.

### 3. Pre-Guardrail — Deterministic — Done

- **Purpose:** the inbound safety gate, before any expensive model reasoning.
- **Checks (points):**
  - **Scope:** off-topic requests are flagged for the guardrail-reject branch.
  - **Injection:** prompt-injection patterns are detected and flagged.
  - **PII partial-masking:** mobile, PAN, and Aadhaar are masked (keep a few edge characters,
    X the middle) so the model sees shape without raw identifiers.
  - **Safe-section forwarding:** only aggregate financial sections (loan counts, DPD buckets,
    enquiry counts) are passed through; `general_info` is held back because it mixes a full
    name with safe signals.
- **Output flag:** `pre_guardrail` true/false plus a reason; false routes to a canned safe reply.

### 4. User Story Creation — LLM — Planned

- **Intended purpose:** build a 2–3 sentence factual narrative of *who* the user is (session,
  profile, episodic + semantic + behavioural memory, journey phase) and inject it into every
  specialist's system prompt — so the specialist knows the person without re-reading 321 vars.
- **Current state:** a placeholder step exists but is **not wired into the live chain**.
- **Blocked on:** the persistent memory store (past goals, hard constraints, prior turns).

### 5. Agent / Skill Resolver — LLM — Done

- **Purpose:** map the resolved intent (+ context) to exactly one downstream skill.
- **Behaviour (points):**
  - Branches deterministically on the Understand intent.
  - If Pre-Guardrail blocked the turn, routing goes to the **guardrail-reject** branch instead
    of any specialist — no model call is made.
  - Exactly one branch fires; the result is collapsed back into a uniform shape for the next node.

| Intent | Branch |
|--------|--------|
| `score_improvement` | Score-improvement specialist |
| `credit_card` | Credit-card specialist |
| `insurance` | Insurance specialist |
| `general` / `bureau_query` | General credix |
| (blocked) | Guardrail-reject (no LLM) |

### 6. Skill / Specialized Agent — LLM + Tool — Done

- **Purpose:** the actual domain reasoning, grounded in the masked profile and the brief.
- **Behaviour (points):**
  - Four specialists share one uniform input/output contract so the workflow stays simple.
  - The prompt carries the **masked** profile context (e.g. credit score, which sections
    exist) — never the raw document.
  - **Tool calls** are bounded (max 3 reasoning steps) and logged: bureau section reads,
    deterministic calculators (EMI, FOIR, DBR, refinance), eligibility/decision checks.
  - Runs under a per-user, per-session memory thread.
  - Guaranteed non-empty: an empty generation is replaced with a safe retry message.
- **Observability:** a PII-safe span records skill, intent, and tool-call count — never the
  prompt or response text.

### 7. Post-Guardrail — Deterministic — Partial

- **Purpose:** the outbound safety gate — nothing identifying leaves in the reply.
- **Done (points):**
  - Scrubs Aadhaar (12 digits) **before** mobile (10 digits) so a partial Aadhaar isn't
    mistaken for two mobile numbers, then PAN.
  - Regex state is reset on every call, so repeated invocations don't silently miss.
- **Gap:** full numeric-traceability re-creation ("every number in the reply traces to a real
  profile value") is basic; deeper re-trace is a follow-up.

| Leak type | Action |
|-----------|--------|
| PAN | Redacted |
| Aadhaar | Redacted |
| Mobile | Redacted |

### 8. Update Memory / User Data — LLM — Planned

- **Intended purpose:** asynchronously persist working memory (goals, constraints, episodic
  summary) after the reply is sent, off the response critical path.
- **Current state:** a **no-op pass-through** — it forwards the response unchanged so the chain
  stays structurally complete. Re-enabling is a one-step change.
- **Blocked on:** the persistent (Postgres) memory store.

### 9. Compose — Deterministic — Done

- **Purpose:** format the final, scrubbed text for the delivery channel.
- **Behaviour (points):**
  - **WhatsApp:** strips markdown emphasis/headings, normalises bullets, trims long paragraphs.
  - **Web:** passes rich text through.
  - **TTS:** plain text suited to speech (numbers stay as digits, never spelled out, so they
    are pronounced correctly).

---

## 6. Cross-cutting concerns

| Concern | How it's handled | Status |
|---------|------------------|--------|
| PII firewall | Stripped at the data layer, masked at Pre-Guardrail, scrubbed at Post-Guardrail; never logged | Done |
| Single fetch | Bureau profile read once at the boundary, passed into the workflow | Done |
| Graceful failure | Model outage → fallback intent; bad input → 400; missing record → friendly reply; sidecar down → 502, no stack trace | Done |
| Observability | PII-safe spans over the run, the classifier, each agent generate, and the bureau fetch — routing/counts only | Done |
| Branch invariant | Every branch (including reject) emits the same shape, so seams stay simple | Done |

---

## 7. Known gaps / next

- [ ] **User Story Creation** — wire the narrative builder once the memory store lands.
- [ ] **Update Memory** — turn the pass-through into an async working-memory write.
- [ ] **Decode** — add the document input path.
- [ ] **Post-Guardrail** — strengthen numeric re-traceability beyond pattern scrubbing.

---

## 8. One-line summary per node (quick reference)

| Node | Summary |
|------|---------|
| Identity Check | Canonical 10-digit id + record check, fail-safe |
| Raw Data Layer | Tiered read-through bureau profile, PII stripped |
| Decode | Text/voice/language in; doc pending |
| Understand | One intent + an action brief, fallback-safe |
| Pre-Guardrail | Scope + injection + PII mask in |
| User Story Creation | Who-is-this narrative (planned) |
| Skill Resolver | Intent → one specialist branch |
| Specialized Agent | Grounded domain reasoning + bounded tools |
| Post-Guardrail | Scrub PAN/Aadhaar/mobile out |
| Update Memory | Async memory write (planned) |
| Compose | Channel formatting out |
