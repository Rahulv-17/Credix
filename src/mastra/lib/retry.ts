async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Calls fn up to maxAttempts times with exponential backoff (500ms, 1000ms, 2000ms, ...).
 * Fast-fails on 4xx errors (except 429 rate-limit) — those are never retriable.
 * Throws a wrapped error after all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label = 'operation',
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      lastError = err
      const status: number | undefined = err?.statusCode ?? err?.status
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw new Error(
          `[${label}] non-retriable (HTTP ${status}): ${err?.message ?? String(err)}`,
          { cause: err },
        )
      }
      if (attempt < maxAttempts) {
        const delay = 500 * 2 ** (attempt - 1)
        console.warn(`[${label}] attempt ${attempt}/${maxAttempts} failed — retrying in ${delay}ms`)
        await sleep(delay)
      }
    }
  }
  throw new Error(
    `[${label}] failed after ${maxAttempts} attempts: ${(lastError as any)?.message ?? String(lastError)}`,
    { cause: lastError },
  )
}
