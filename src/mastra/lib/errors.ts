// Base class for all operational errors — carries an HTTP status code and machine-readable
// code so Hono's onError handler can produce a consistent JSON response without branching.
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly isOperational = true

  constructor(message: string, statusCode: number, code: string) {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.code = code
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  toHttpResponse() {
    return {
      success: false as const,
      error: { message: this.message, code: this.code },
    }
  }
}

// Bureau sidecar returned an error. sidecarStatus is the raw HTTP status from FastAPI.
// 404 → the user simply has no record (client error, HTTP 404 to caller).
// Anything else → infra issue (HTTP 502 Bad Gateway to caller).
export class BureauSidecarError extends AppError {
  readonly sidecarStatus: number

  constructor(sidecarStatus: number, context = '') {
    const notFound = sidecarStatus === 404
    const base = notFound
      ? `Bureau record not found${context ? ` for ${context}` : ''}`
      : `Bureau sidecar unavailable (HTTP ${sidecarStatus})${context ? ` for ${context}` : ''}`
    super(base, notFound ? 404 : 502, notFound ? 'BUREAU_NOT_FOUND' : 'BUREAU_SIDECAR_ERROR')
    this.sidecarStatus = sidecarStatus
  }
}

// xAI / Grok API returned a non-2xx status.
export class LLMApiError extends AppError {
  readonly llmStatus: number

  constructor(llmStatus: number) {
    super(`LLM API returned ${llmStatus}`, 502, 'LLM_API_ERROR')
    this.llmStatus = llmStatus
  }
}

// ElevenLabs Speech-to-Text failed after all withRetry attempts.
export class STTError extends AppError {
  constructor(detail: string) {
    super(`STT failed: ${detail}`, 502, 'STT_ERROR')
  }
}

// ElevenLabs Text-to-Speech failed after all withRetry attempts.
export class TTSError extends AppError {
  constructor(detail: string) {
    super(`TTS failed: ${detail}`, 502, 'TTS_ERROR')
  }
}

// Input did not pass validation — carries per-field details for the caller.
export class ValidationError extends AppError {
  readonly details: Array<{ field: string; message: string }>

  constructor(message: string, details: Array<{ field: string; message: string }> = []) {
    super(message, 400, 'VALIDATION_ERROR')
    this.details = details
  }

  toHttpResponse() {
    return {
      success: false as const,
      error: { message: this.message, code: this.code, details: this.details },
    }
  }
}
