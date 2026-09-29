export function normalizeUserId(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  const normalized = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits.slice(-10)
  return /^\d{10}$/.test(normalized) ? normalized : null
}

/**
 * Resolve the user_id for a tool call: the server-verified id in the request context wins, and the
 * LLM-supplied arg is only a fallback for direct calls made outside a run (tests, scripts).
 *
 * The arg is optional in the tool schemas on purpose. While it was required, a worker that trusted the
 * context and omitted it had its call rejected by input validation BEFORE execute ran, so the
 * context-first lookup never happened and the dropped-value case stayed broken (PR #19 review).
 * With neither source available this throws, rather than silently reading whoever the fallback names.
 */
export function resolveUserId(
  arg: string | undefined,
  context?: { requestContext?: { get: (key: string) => unknown } },
): string {
  const fromContext = context?.requestContext?.get('user_id')
  const user_id = (typeof fromContext === 'string' ? fromContext : undefined) ?? arg
  if (!user_id) throw new Error('user_id unavailable: no request context and no user_id argument')
  return user_id
}
