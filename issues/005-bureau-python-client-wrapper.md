# Issue 005, Bureau Python client wrapper

**Tracking:** Epic [ZT-260, FRIDAY v1 Credix App](https://finbud.atlassian.net/browse/ZT-260)
**Type:** AFK
**Parent:** `tasks/todo.md` Phase 9 (Raw Data Layer)
**Goal:** make bureau data for any user trivially accessible from Python in one import, with a production grade facade over the read through resolver (Redis L1, Mongo L2, Snowflake L3).

---

## Why

Today every Python caller that wants bureau data has to know the plumbing. Look at `src/nodes/api/routes/bureau_internal.py`: it imports `get_resolver` AND `mobile_to_user_id`, normalizes the mobile itself, calls `get_resolver().resolve(normalized)`, unpacks a `(doc, source)` tuple, decides what `source == "miss"` means, calls `doc.pop("pii", None)` by hand, and for a single section it reaches into `get_resolver().redis.get_path(user_id, "$.section")` using raw JSONPath. That is the resolver's internals leaking into every consumer.

Research on production grade Python client libraries (openai-python, anthropic-sdk-python, stripe-python, plus the patterns writeups gathered during this task) converges on a clear shape:

1. A single typed surface that callers import once, internals stay private.
2. The wrapper understands the semantics of the calls it wraps (it strips PII, it knows what a section is), it does not just forward arguments.
3. A structured exception hierarchy: distinguish caller mistakes, no data, and infra failures. Do not collapse them all into `None`.
4. Thin not thick: expose escape hatches (per call timeout, force refresh) rather than guessing.
5. No blocking I/O on the async path: the existing resolver is fully synchronous (pymongo, sync redis, snowflake), so the async facade must offload to a worker thread.

The currently empty `errors.py` and `partial_reads.py` Phase 1 scaffolds are the natural homes for items 2 and 3.

---

## Scope

### In scope
1. A single import facade, `src/nodes/raw_data/bureau/client.py`.
2. A typed exception hierarchy in `src/nodes/raw_data/bureau/errors.py`.
3. Section selection logic in `src/nodes/raw_data/bureau/partial_reads.py` (move the JSONPath knowledge out of the route).
4. `snowflake_client.py` library hygiene (Phase 9b, folded in here because it blocks clean importing).
5. Unit tests with the resolver mocked.

### Out of scope
1. Full async rewrite of the resolver to motor plus redis.asyncio. The facade offloads the sync resolver to a thread via `asyncio.to_thread`, full async is a later issue.
2. Changing the resolver's L1, L2, L3 logic or the cache schema.
3. Rewriting `bureau_internal.py` route handlers beyond pointing them at the new facade (a follow up, kept small here to avoid a large diff).

---

## Deliverables

### 1. `errors.py`, typed exception hierarchy

```python
class BureauError(Exception):
    """Base for every bureau resolution failure."""

class InvalidMobile(BureauError, ValueError):
    """Mobile number could not be normalized to 10 digits."""

class BureauUnavailable(BureauError):
    """A storage or source layer failed: Redis, Mongo, Snowflake, or lock timeout.
    Carries the originating layer name for logs and metrics."""
    def __init__(self, layer: str, message: str):
        self.layer = layer
        super().__init__(f"{layer}: {message}")
```

Design decision, deviation from the Phase 9 note: the Phase 9 note said "return `None` on no record OR sidecar down". We split those. `None` means the user genuinely has no bureau record (a real, expected outcome). Infra failure raises `BureauUnavailable`. Collapsing both into `None` would make a Redis outage look identical to a brand new user, and every caller would silently serve "no data" during an outage. The research is explicit on this: surface errors as data, do not return `None` everywhere.

### 2. `partial_reads.py`, section selection

Replace the empty scaffold with the canonical section catalog and a pure selector:

- `VALID_SECTIONS`: the frozenset currently hardcoded in `bureau_internal.py`, moved here so route and client share one source of truth.
- `select_section(doc: dict, section: str) -> dict | None`: validates the section name (raises `ValueError` on unknown), reads it out of an already resolved doc, returns the section payload or `None` if absent. No Redis JSONPath dependency, it operates on the plain dict the resolver returns, which keeps the selector trivially testable.

### 3. `client.py`, the facade

The ergonomic surface, two async functions plus an optional sync pair for non async callers:

```python
async def get_bureau_profile(mobile: str, *, force_refresh: bool = False) -> dict | None:
    """Full PII stripped bureau profile for a mobile, or None if no record exists.
    Raises InvalidMobile on a bad number, BureauUnavailable on infra failure."""

async def get_bureau_section(mobile: str, section: str) -> dict | None:
    """One section (general_info, loan_details, ...) PII stripped, or None.
    Raises InvalidMobile, BureauUnavailable, ValueError (unknown section)."""
```

Behavior:
1. Normalize the mobile via `mobile_to_user_id`, converting its `ValueError` into `InvalidMobile`.
2. Run the synchronous `get_resolver().resolve(...)` inside `asyncio.to_thread(...)` so the event loop is never blocked (honors the code quality rule, no blocking I/O in async code).
3. Map resolver outcomes: `source == "miss"` or `doc is None` returns `None`, a caught `TimeoutError` (lock timeout) or storage exception becomes `BureauUnavailable(layer, ...)`.
4. Strip PII centrally (`doc.pop("pii", None)`) so no caller has to remember to.
5. Reuse the existing singleton from `factory.get_resolver()`, no new connections.
6. `force_refresh` is the escape hatch, threaded through to the resolver so a caller can bypass cached layers when needed. If the resolver does not yet accept it, add a minimal `force_refresh` parameter to `ProfileResolver.resolve` that skips the L1 and L2 reads.

Synchronous convenience wrappers `get_bureau_profile_sync` / `get_bureau_section_sync` for callers not already in an event loop (scripts, the sync FastAPI route), each a thin call straight into the resolver with the same error mapping.

Target usage:

```python
from nodes.raw_data.bureau.client import get_bureau_profile
profile = await get_bureau_profile("9876543210")   # dict or None, PII already gone
```

### 4. `snowflake_client.py` hygiene (Phase 9b)

Make the module importable with zero side effects:
1. `load_dotenv()` at import time: move inside `connect()` or drop it, FastAPI startup already loads env.
2. `print()` in `connect()`: replace with `logging.debug(...)`, one raw print per connection currently leaks to production logs.
3. CLI dead code (`parse_args`, `run`, `main`, the `__main__` block): move to `scripts/fetch_bureau_profile.py` so importing the library runs nothing.
4. `DEFAULT_CONNECTION = os.getenv(...)` at module level: read inside `connect()` so a runtime env change is honored, not frozen at import.

What stays: `fetch_scrub_row` is correct and is the resolver's L3 source via `factory.py`, leave it.

### 5. Tests, `tests/unit/test_bureau_client.py`

Resolver fully mocked, no live Redis, Mongo, or Snowflake:
1. Profile happy path returns the doc with the `pii` key removed.
2. No record (`source == "miss"`) returns `None`.
3. Bad mobile raises `InvalidMobile`.
4. Resolver `TimeoutError` raises `BureauUnavailable` with `layer == "lock"`.
5. A storage exception raises `BureauUnavailable` with the right layer.
6. Section happy path returns just that section, PII stripped.
7. Unknown section raises `ValueError`.
8. `force_refresh=True` passes through and skips the cache layers (assert the resolver received it).
9. The async path does not block: assert the resolver call ran via `to_thread` (the resolver was invoked off the calling thread).

---

## Acceptance criteria
- [ ] `from nodes.raw_data.bureau.client import get_bureau_profile, get_bureau_section` works with no extra imports for the caller.
- [ ] Returned dicts never contain a `pii` key.
- [ ] No record returns `None`, infra failure raises `BureauUnavailable`, bad input raises `InvalidMobile`. The three are distinguishable.
- [ ] Async functions never block the event loop (sync resolver runs in a thread).
- [ ] `snowflake_client.py` import has no side effects (no print, no dotenv load, no arg parsing).
- [ ] `bureau_internal.py` imports `VALID_SECTIONS` and the section selector from the shared modules, the route no longer hardcodes the set or touches `redis.get_path` directly.
- [ ] `uv run ruff format` and `uv run ruff check --fix` clean on every touched file.
- [ ] `pytest tests/unit/test_bureau_client.py` green, all 9 cases.

---

## Invariants carried
| Invariant | Where |
|---|---|
| PII never leaves the wrapper | `client.py` strips `pii` centrally |
| One shared resolver, one connection set | `factory.get_resolver()` singleton reused |
| Canonical id is the 10 digit mobile | `mobile_to_user_id`, unchanged |
| No blocking I/O on the async path | `asyncio.to_thread` around the sync resolver |
| Section names have one source of truth | `partial_reads.VALID_SECTIONS` |
