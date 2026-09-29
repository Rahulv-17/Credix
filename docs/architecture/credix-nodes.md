# Credix Runtime: Node-by-Node Working

*A code-grounded walk-through of how a single chat turn flows through the credix, one node at a
time. For the conceptual pipeline and implementation-status view, see the sibling document
[turn1-pipeline.md](../turn1-pipeline.md); this document explains what each node actually does in
the current code, with file references you can open and verify.*

---

## 1. Purpose

The credix answers a user's credit and money questions in one conversational turn. A turn begins
when a message arrives at the HTTP boundary and ends when a formatted reply is returned. Between
those two points the request passes through a fixed sequence of small, single-responsibility units.
Each unit is called a node.

This document describes every node in the order it runs, explains the job it performs, names the
file that implements it, and states how it behaves when something goes wrong. The goal is that a
reader who has never opened this codebase can follow a turn from start to finish and understand why
each step exists.

---

## 2. Where It Is Implemented

The credix runs as two cooperating processes:

1. **The orchestrator** (TypeScript, using the Mastra framework), under `src/mastra/`. This is where
   the turn is coordinated. The HTTP boundary is [server.ts](../../src/mastra/server.ts), the node
   sequence is defined in [workflows/credix-workflow.ts](../../src/mastra/workflows/credix-workflow.ts),
   and each node lives in its own file under [steps/](../../src/mastra/steps/).
2. **The bureau sidecar** (Python), under `src/nodes/`. This owns the user's raw credit-bureau data,
   computes derived signals, and serves both over internal HTTP endpoints.

The orchestrator never reads the warehouse or the raw data directly. It always asks the sidecar,
which keeps the sensitive-data logic in one place.

---

## 3. Key Terms

- **Node / step.** One unit of work in the turn. In code, most nodes are created with `createStep`
  and given a stable string id (see the id list in [lib/patterns.ts](../../src/mastra/lib/patterns.ts)).
- **Workflow.** The ordered chain of nodes, wired together in
  [credix-workflow.ts](../../src/mastra/workflows/credix-workflow.ts) with `.then(...)`,
  `.branch(...)`, and `.map(...)`.
- **Branch.** A fork where exactly one downstream node runs depending on the classified intent.
- **Agent (specialist).** A node that calls a large language model with a role-specific persona and a
  set of tools it may invoke.
- **Tool.** A function the model may call mid-answer, for example a bureau section lookup or an EMI
  calculator.
- **Sidecar.** The Python service that owns bureau data and signals.
- **Bureau profile.** The user's full credit record, roughly 321 variables, organised into sections.
- **PII.** Personally identifying information, for example PAN, Aadhaar, mobile number, name, date of
  birth. Handling PII safely is a hard requirement at every node.
- **Masked profile.** A safe copy of the profile with identity fields removed or partially hidden,
  built specifically so it can be shown to the language model.
- **Intent.** One of five request categories the turn is classified into, which decides the branch.
- **Span.** A privacy-safe tracing record emitted by a node for observability; it holds counts and
  categories, never message text or raw personal values.

---

## 4. The Request Lifecycle At A Glance

The first three nodes run once at the API boundary, before the workflow starts. Everything from
Decode onward runs inside the orchestrated workflow. The live order is:

```
Boundary (server.ts, runs once per request):
  1. Identity Check        normalise the mobile to a 10-digit user_id
  2. Bureau fetch          fetch the full profile once (single-fetch rule)
  3. Signals fetch         fetch precomputed persona signals (optional enrichment)

Workflow (credix-workflow.ts):
  4. Decode                normalise input to text plus a detected language
  5. Pre-Guardrail         block unsafe input; build the masked profile
  6. Understand            classify intent (and ground the web, concurrently)
  7. Branch                route to exactly one of five nodes:
        score-improvement | credit-card | insurance | general | guardrail-reject
  8. Seam 1 (map)          collapse the fired branch into one uniform shape
  9. Post-Guardrail        scrub any leaked PAN / Aadhaar / mobile from the reply
 10. Memory Writeback      update long-term memory for the thread (fail-soft)
 11. Seam 2 (map)          rebuild the input the compose node needs
 12. Compose              format the reply for the delivery channel
```

Two design rules shape this order. First, the cheap safety screen (Pre-Guardrail) runs before any
expensive model call. Second, the bureau profile is fetched exactly once and passed inward, so no
later node re-fetches it.

---

## 5. Node-by-Node

### 5.1 Identity Check (boundary, deterministic)

- **File:** [steps/identity-check.ts](../../src/mastra/steps/identity-check.ts), using
  [lib/normalize-user-id.ts](../../src/mastra/lib/normalize-user-id.ts). At the live boundary the
  same normalisation runs inline in [server.ts:82](../../src/mastra/server.ts#L82).
- **Role:** turn whatever the user typed as a phone number into the single canonical 10-digit
  `user_id` used by every layer, and confirm the person has a bureau record.
- **How it works:** it accepts a bare 10-digit number, optionally with a recognised country or trunk
  prefix, and rejects anything that cannot be resolved cleanly rather than truncating it, so two
  different inputs can never collapse onto the same user. It then asks the sidecar whether a record
  exists.
- **Failure behaviour:** it never throws. A malformed number, a missing record, and an unreachable
  sidecar each return a distinct outcome, so the boundary can answer with the right message instead
  of crashing.

### 5.2 Bureau Fetch (boundary, raw data)

- **File:** [lib/bureau-fetch.ts](../../src/mastra/lib/bureau-fetch.ts), called at
  [server.ts:95](../../src/mastra/server.ts#L95). The data itself is served by the Python sidecar.
- **Role:** fetch the user's full bureau profile once per request and hand it into the workflow.
- **How it works:** this is the single-fetch rule in action. The profile is read one time here and
  passed into the workflow as input, so downstream nodes work from that copy instead of fetching
  again. The sidecar serves the profile from a read-through set of tiers: a fast key-value cache
  first, then a durable document store, then the warehouse on a miss or when stale.
- **Failure behaviour:** a missing record returns a friendly reply asking the user to try their
  registered bank mobile number; a sidecar outage returns a 502 without leaking internal detail.

### 5.3 Signals Fetch (boundary, raw data, optional)

- **File:** [lib/user-story-fetch.ts](../../src/mastra/lib/user-story-fetch.ts), called at
  [server.ts:111](../../src/mastra/server.ts#L111).
- **Role:** fetch the precomputed persona signals for this user, namely the derived insights produced
  by the signal engine (see [signal-engine.md](signal-engine.md) for how those are computed).
- **How it works:** the signals ride alongside the profile with the same single-fetch posture and
  their own in-process cache. They are enrichment only, so a miss or an error is non-fatal; the turn
  proceeds on the masked profile alone.
- **Privacy note:** the signals payload may carry exact age and income estimates. Those are allowed
  to reach the agent through this path, but never a log or a tracing span.

### 5.4 Decode (workflow, deterministic)

- **File:** [steps/decode.ts](../../src/mastra/steps/decode.ts).
- **Role:** turn whatever modality arrived into normalised text plus a detected language.
- **How it works:** plain text is normalised and passed through. Audio input, identified by its file
  type, is sent to a speech-to-text service and the transcript is normalised. Language is detected by
  inspecting the script of the characters (for example Devanagari maps to Hindi, and there are ranges
  for Gujarati, Bengali, and Tamil), defaulting to English when no other script dominates.
- **Current gap:** document input is not yet wired; only text and audio are handled today.

### 5.5 Pre-Guardrail (workflow, deterministic)

- **File:** [steps/pre-guardrail.ts](../../src/mastra/steps/pre-guardrail.ts).
- **Role:** the inbound safety gate and the builder of the masked profile. It runs before any model
  call so that unsafe requests are rejected cheaply.
- **How it works:** it screens the text against prompt-injection patterns and genuinely unsafe or
  abusive patterns. Ordinary off-topic or personal-interest messages are deliberately not blocked
  here; they are allowed through to the model, which bridges them back to money topics through the
  shared persona. If a pattern matches, the node sets a flag that will route the turn to the
  guardrail-reject node.
- **The masked profile:** this node also builds the masked profile from the pre-fetched bureau
  document. It works deny-by-default: it starts from an empty object and copies in only allowlisted,
  safe sections (aggregate financial data such as loan counts, enquiry counts, and delinquency
  buckets), plus a small allowlist of safe fields from the mixed section, plus a partially masked
  copy of the three known identity fields. The raw document is never spread wholesale, so a new field
  added upstream cannot leak by accident.
- **Output:** a pass or fail flag with a reason, the decoded text, and the masked profile.

### 5.6 Understand (workflow, model call)

- **File:** [steps/understand.ts](../../src/mastra/steps/understand.ts).
- **Role:** classify the message into exactly one of five intents, which decides the branch. The five
  intents are bureau query, score improvement, credit card, insurance, and general.
- **How it works:** if Pre-Guardrail blocked the turn, this node short-circuits and spends no model
  call. Otherwise it calls a small, stateless classifier model that returns only the intent. The
  classification is intentionally intent-only, because this call sits on the critical path of every
  turn and its latency is dominated by output length; the specialist later decomposes the request
  itself.
- **Concurrent web grounding:** at the same time as classification, and inside its own tracing span,
  the node runs a live web lookup on the user message. Because it runs concurrently, its cost hides
  under the classification latency. The result is discarded for bureau queries, whose answers live in
  the profile rather than on the web.
- **Failure behaviour:** a malformed model response falls back to the general intent; a transport or
  server failure also falls back to general and records a degradation marker, so the turn still
  completes and the outage is still visible to monitoring.

### 5.7 Branch and the Skill Resolver (workflow, routing)

- **File:** the `.branch(...)` block in
  [credix-workflow.ts:216](../../src/mastra/workflows/credix-workflow.ts#L216).
- **Role:** send the turn to exactly one downstream node based on the guardrail flag and the intent.
- **How it works:** the branch maps a blocked turn to the guardrail-reject node, and each specialist
  intent to its specialist node. The general node is the catch-all for everything else. An important
  detail of the framework is that every branch whose condition is true will run, so the conditions
  are written to be mutually exclusive; the general branch explicitly excludes the three specialist
  intents so that two agents never fire on the same turn.

### 5.8 The Specialist Agents and Guardrail-Reject (workflow, model call plus tools)

- **File:** the `makeAgentStep` wrapper and the branch nodes in
  [credix-workflow.ts:66](../../src/mastra/workflows/credix-workflow.ts#L66); the agents live in
  [agents/](../../src/mastra/agents/).
- **Role:** perform the actual domain reasoning and produce the answer.
- **How it works:** all four specialists share one uniform wrapper so the workflow stays simple. The
  wrapper assembles the prompt from the masked profile, the intent, a short privacy-safe signal
  summary, an optional statement hint, the web context, and the user message. It then calls the model
  with a bounded reasoning budget (at most 3 tool-using steps) under a per-user, per-session memory
  thread. It records which tools were called, guarantees the answer is never an empty string, and
  emits a privacy-safe span with the skill, the intent, and the tool-call count.
- **The specialists:** score improvement, credit card, insurance, and general credix (the general
  node also handles bureau queries). They share the Rahul persona defined in
  [agents/persona.ts](../../src/mastra/agents/persona.ts), which enforces the house style: short and
  warm replies, digits rather than spelled numbers, no dashes, and never revealing PAN, Aadhaar, or a
  full mobile number.
- **Tools available:** a bureau section lookup, financial calculators, a card-eligibility check
  (credit-card specialist only), a web search, an uploaded-statement reader, and the signals reader.
  Tools exist so the model can pull a specific missing detail rather than guess.
- **Guardrail-reject:** when Pre-Guardrail blocked the turn, this node produces a short, safe
  redirection message with no model call, matching the same output shape as the specialists.
- **Failure behaviour:** transient model failures are retried; a persistent failure returns a safe,
  retryable message and records a degradation marker rather than failing the turn.

### 5.9 Seam 1: Collapse the Branch (workflow, glue)

- **File:** the first `.map(...)` at
  [credix-workflow.ts:231](../../src/mastra/workflows/credix-workflow.ts#L231).
- **Role:** whichever branch fired, reduce its result to the single uniform shape the next node
  expects. Branches that did not run report nothing, so this seam selects the one that did and passes
  its answer, its tool log, and its active skill forward. This glue keeps the seams between nodes
  simple and predictable.

### 5.10 Post-Guardrail (workflow, deterministic)

- **File:** [steps/post-guardrail.ts](../../src/mastra/steps/post-guardrail.ts).
- **Role:** the outbound safety gate, ensuring nothing identifying leaves in the reply.
- **How it works:** it scrubs Aadhaar first, then PAN, then mobile numbers, replacing each with a
  redaction marker. Aadhaar is scrubbed before mobile on purpose, so that a partial Aadhaar is not
  mistaken for two separate mobile numbers. The matching state is rebuilt on every call so repeated
  invocations cannot silently miss.
- **Current gap:** deeper numeric traceability, meaning a guarantee that every number in the reply
  maps back to a real profile value, is still basic and is a planned follow-up.

### 5.11 Memory Writeback (workflow, may call a model, fail-soft)

- **File:** [steps/memory-writeback.ts](../../src/mastra/steps/memory-writeback.ts).
- **Role:** update the user's long-term memory for this conversation thread after the answer is
  ready. This node now actively drives Observational Memory; it is no longer a placeholder.
- **How it works:** it asks the memory engine, through a cheap read that spends no model call,
  whether the thread has crossed the thresholds for observing or reflecting. Only when the engine
  says so does it spend a model call to condense the conversation into durable memory. It keys the
  work on the session thread and skips silently when there is no thread to key on.
- **Failure behaviour:** every part is fail-soft. A memory hiccup is recorded and ignored so it can
  never break the reply. Structurally the node passes the response through unchanged, so the chain
  stays intact.

### 5.12 Seam 2: Rebuild the Compose Input (workflow, glue)

- **File:** the second `.map(...)` at
  [credix-workflow.ts:243](../../src/mastra/workflows/credix-workflow.ts#L243).
- **Role:** assemble exactly the input the compose node needs, namely the scrubbed response, the
  channel, the session, and the active skill. This seam also recovers the degradation markers set
  earlier (an intent fallback in Understand, or a specialist that returned its safe fallback), since
  neither throws and this is the only place a real backend outage becomes visible in the result.

### 5.13 Compose (workflow, deterministic)

- **File:** [steps/compose.ts](../../src/mastra/steps/compose.ts).
- **Role:** format the final, scrubbed answer for the delivery channel.
- **How it works:** for WhatsApp it strips markdown emphasis and headings, normalises bullets, and
  trims long paragraphs. For web it passes rich text through. For voice it produces plain speakable
  text and synthesises audio, keeping numbers as digits so they are pronounced correctly.
- **Failure behaviour:** compose is the last node, so a voice-synthesis outage must not discard an
  already-finished answer. It falls back to returning the spoken text and flags that the audio step
  failed, rather than turning a good reply into an error.

---

## 6. Cross-Cutting Concerns

These behaviours are not single nodes; they are guarantees the whole pipeline upholds.

- **The PII firewall.** Personal data is stripped at the data layer, partially masked at
  Pre-Guardrail before any model sees it, and scrubbed again at Post-Guardrail on the way out. It is
  never written to a log or a tracing span.
- **Single fetch.** The bureau profile is read once at the boundary and passed inward, so no node
  re-fetches it during the turn.
- **Graceful degradation.** A model outage falls back to the general intent or a safe reply; a bad
  input returns a clear error; a missing record returns a friendly message; a sidecar outage returns
  a clean 502. The turn is designed never to crash mid-way.
- **The branch invariant.** Every branch, including the reject branch, produces the same output
  shape, which is what lets the seams stay simple.
- **Observability.** Privacy-safe spans wrap the run, the classifier, each specialist call, the
  bureau fetch, and the signals fetch. They record routing and counts only, never message content.

---

## 7. Where State Is Stored

- **Bureau profile:** served by the sidecar from a fast cache, a durable document store, and the
  warehouse, in that read-through order.
- **Persona signals:** precomputed by the signal engine and stored in the sidecar, then cached
  in-process by the orchestrator for the conversation. See [signal-engine.md](signal-engine.md).
- **Uploaded statements:** ingested through a separate endpoint
  ([server.ts:158](../../src/mastra/server.ts#L158)) and stored per user so the specialist can read
  them on later turns.
- **Conversation memory:** persisted per user and per session, and updated by the Memory Writeback
  node.

---

## 8. Reliability And Verification

Every node that talks to an external service is wrapped so that a transient failure is retried and a
persistent failure degrades safely rather than failing the turn. The happy path runs live against a
real model and real bureau data, and is exercised by the test suite. The pipeline is deliberately
built so that no single node outage produces a hard error for the user.

---

## 9. Status: Shipped Versus Pending

- **Fully working:** Identity Check, Bureau fetch, Signals fetch, Pre-Guardrail, Understand, the
  branch and all four specialists, Post-Guardrail scrubbing, Memory Writeback (now driving
  Observational Memory), and Compose for all three channels.
- **Partial:** Decode does not yet accept document input; Post-Guardrail numeric traceability is
  basic.
- **Pending:** the written user-story narrative, meaning a short prose paragraph describing who the
  user is, is still a stub at [steps/user-story.ts](../../src/mastra/steps/user-story.ts). Note that
  the persona signals it was meant to summarise are already computed and already reach the agent
  through the signals path described in section 5.3, so the missing piece is only the prose rendering.

---

## 10. Appendix: File Map And Identifiers

- **Boundary and orchestration:**
  [server.ts](../../src/mastra/server.ts),
  [workflows/credix-workflow.ts](../../src/mastra/workflows/credix-workflow.ts),
  [index.ts](../../src/mastra/index.ts).
- **Nodes:** [steps/](../../src/mastra/steps/), one file per node
  (identity-check, decode, pre-guardrail, understand, post-guardrail, memory-writeback, compose,
  user-story).
- **Specialists and persona:** [agents/](../../src/mastra/agents/).
- **Tools:** [tools/](../../src/mastra/tools/) (bureau, calculators, eligibility, exa, signals,
  statement).
- **Shared identifiers:** intents and canonical step ids are defined in
  [lib/patterns.ts](../../src/mastra/lib/patterns.ts).
- **Intents (5):** bureau_query, score_improvement, credit_card, insurance, general.
- **Branch targets (5):** score_improvement, credit_card, insurance, general, guardrail-reject.
