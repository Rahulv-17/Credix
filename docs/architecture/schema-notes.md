# User memory schema — design notes (v2)

These notes explain *why* `user_memory_schema_v2.json` is shaped the way it is.
Each rule below came out of a grilling session on the original v1 example. If you
are tempted to undo one of these, read the reason first.

## What this document is — and what it is not

This is the **personalization memory**: who the user is, how Rahul should talk to
him, and what he is working toward. It is **slow-changing** — it moves on the
timescale of personality, not the timescale of his bank balance.

It is deliberately **not** financial truth. The live score, FOIR, DPD and the other
320 bureau variables live in Snowflake and are fetched fresh every turn by
`build_rahul_brief(user_id)` (the resolver in `pre-processing/`). The two are
**joined at read time** in the synthesizer prompt — they are never merged into one
stored document.

## The two consumers (and two views)

There are two different programs that touch this doc, and they want different things:

1. **The writer** — a cheap LLM (Haiku-class) that runs **asynchronously, off the
   response hot path** (a light update after each turn; a full re-summarise at
   session end). It owns and maintains the structured fields. Running it inline
   would tax every reply, so it never does.
2. **The reader** — the synthesizer LLM that generates Rahul's reply. It does **not**
   receive this raw document. It receives a compact **projection** built from it:
   the `summary`, the `directives`, the top few `slang_markers`, and the active
   `goals`. Bookkeeping fields (`observed_count`, `last_seen_turn`, `status`) never
   enter the prompt — an LLM cannot act on a count, only on prose and clear rules.

Because of this split, **`summary` is the single most important field**, not a
redundant one. It is the main thing the reader actually reads.

## The rules

### 1. Store a number only if memory *owns* it
A number belongs here only if this document is its authoritative source, or if it is
a **deliberately frozen historical snapshot**.

- **Kept:** `declared_income_monthly` (self-reported, the bureau does not know what he
  *told* us), goal `target` (his aspiration), goal `baseline` + `baseline_captured`
  (a dated snapshot that is correct forever).
- **Removed:** live score, FOIR, DPD, `current_value`, `progress`, `milestones_done`.
  These are owned by the brief. A copy here can only be redundant (no value) or stale
  (a lie). Goal progress is computed at read time: `current = brief[metric]`, then
  `current - baseline` against `target`.

### 2. The `summary` carries no financial figures
It describes *how to talk about* the money (sensitivities, his real lever), never the
numbers themselves. The numbers come fresh from the brief. A frozen "FOIR ~63%" in
prose is the worst kind of stale data — invisible and confidently wrong.

### 3. Confidence is evidence, not a vibe
v1 had per-field `confidence: 0.55` floats. A cheap writer cannot calibrate a float
and an LLM reader cannot act on 0.55 vs 0.65. Replaced with what a cheap model *can*
maintain by counting: `status` (`confirmed` / `inferred` / `tentative`) plus
`observed_count` and `last_seen_turn`. These also drive **decay** — a one-off
inference from 40 turns ago should not read as established fact.

### 4. Observed facts vs. directives are separated
Every field is either something the writer *noticed* (`observed`) or a rule the agent
*obeys* (`directives`). They have different lifetimes and different owners:

- `observed.*` — the writer updates freely each turn; carries status/counts; decays.
- `directives.*` — change **only** on an explicit signal from the user; the writer is
  told not to touch them otherwise.

This split is also the simplest, safest instruction you can give the cheap writer:
"update `observed`; leave `directives` alone unless the user explicitly asked."

### 5. Low-stakes style auto-mirrors; high-stakes relational dials are gated
- **Auto (from `observed`):** slang, register, message length, playfulness. Echoing
  his own words back cannot presume anything — it is matching, not asserting.
- **Gated (explicit signal / consent):** `address_as` (the vocative asserts a
  relationship) and roast (can wound — gated by `consent.roast_ok`).

`address_as` therefore **defaults to `preferred_name`** and flips only when the user
states a preferred form of address. v1's bug: it inferred `address_as: "bhai"` from
the observation that *he* calls *Rahul* "bhai" — an inverted, presumptuous guess. A
plain name you got right beats an honorific you got wrong.

### 6. Store each fact once; calculate the rest
A cheap writer that must keep two copies in sync will eventually desync them.

- Removed the duplicate `turn_count` (kept one, in `engagement`).
- Removed the duplicate roast flag (kept `consent.roast_ok` — consent owns it).
- Removed `commitment_count`, `commitment_kept`, `follow_through_ratio`, `last_worker`
  — all derivable from `facts.commitments` / `worker_history` at read time.
- Removed `generation` (from `age_band`) and `region_language` (from `city`).
- Collapsed four playfulness fields (`emoji_tolerance`, `humor_receptivity`, two roast
  flags) to two: `consent.roast_ok` (the permission) + `observed.playfulness` (the
  observation).

### 7. Commitments have a lifecycle
Every commitment gets `status` (`open` → `kept` / `broken` / `expired`) and an
`expires` date. The session-end writer pass resolves open commitments against
behavior so the list does not become a graveyard of stale promises.

### 8. PII: honest flag, deterministic enforcement
"PII" here means government identifiers (Aadhaar, PAN, account numbers). Name, city,
age-band and declared income **stay** — Rahul needs them to sound personal.

- The flag is renamed `sensitive_ids_scrubbed` (not the misleading `pii_stripped`), so
  no one downstream thinks name/city are gone.
- The flag is **stamped by a deterministic regex firewall** on the write path, not
  self-certified by the cheap LLM. A probabilistic writer cannot honestly guarantee a
  scrub; regex catches the PAN that the model lets slip into `last_topic`.

### 9. Canonical key = 10-digit mobile
`meta.user_id` is the bare 10-digit mobile (`mobile_to_user_id`), matching the Phase 8
decision and the bureau pipeline's key. The old sha256 `token` and the
`cc:profile:{token}` convention are gone; the cache key is `cc:profile:{user_id}`.

## Open items for implementation
- None of the read/write machinery exists in code yet (`rahul-front/backend/agent.ts`
  is still a bare echo node). When built: the write path needs the regex PII firewall;
  the read path needs the projection builder and the brief join.
- Decide concrete decay windows for `observed.*` (how many turns until an `inferred`
  field drops to `tentative` / is dropped).
- Define the exact `metric` keys goals may reference, mapped to brief variable names.
