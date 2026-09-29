# Code quality

## Python

- Run `uv run ruff format <file>` and `uv run ruff check <file> --fix` after every Python edit.
- Agent node functions: always `async def`, always return `dict` (state patch).
- No blocking I/O in async code — use `motor` for MongoDB, `asyncio` for everything else.
- Never add mutable default arguments.

## TypeScript / Next.js (rahul-front/)

- Run `npx tsc --noEmit` for type checks before committing frontend changes.
- LangGraph SDK messages: always `{role: "user"}` not `{type: "human"}` — the SDK coerces the latter to LangChain wire format the Python server rejects.
- Memoize hook adapters with `useMemo([], ...)` — recreating on every render causes runtime resets.
- Never leave `pii_stripped: false` hardcoded — identity node manages that flag.

## Security

- No API keys or secrets in source code. Always `os.getenv()`.
- PII passes through PII Firewall middleware — never log raw user messages.
- CIBIL scores and financial data never logged in plaintext.

## Numeric output

- All money, scores, and percentages as digits, never spelled out. Synthesizer has a hard rule for this — TTS mispronounces spelled numbers.
