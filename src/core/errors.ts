import type { ProviderId, PublicUsageError } from './types.js'

export type UsageErrorCode = PublicUsageError['code']

export class UsageDashboardError extends Error {
  readonly code: UsageErrorCode
  readonly providerId?: ProviderId
  readonly status?: number

  constructor(code: UsageErrorCode, message: string, options?: { providerId?: ProviderId; status?: number }) {
    super(message)
    this.name = 'UsageDashboardError'
    this.code = code
    if (options?.providerId !== undefined) this.providerId = options.providerId
    if (options?.status !== undefined) this.status = options.status
  }
}

function safeDiagnosticMessage(code: UsageErrorCode): string {
  // Error text may contain opaque credentials with no recognizable prefix.
  // Publish only messages owned by this module, never the original exception.
  const generic: Record<UsageErrorCode, string> = {
    'bad-request': 'The usage request is invalid.',
    'endpoint-not-allowed': 'The provider endpoint is not allowed.',
    'credential-missing': 'A provider credential is not configured.',
    'credential-rejected': 'The provider rejected the configured credential.',
    'credential-not-writable': 'The Harness credential store is not writable from this panel. Add the reference in Harness credential management instead.',
    'provider-http': 'The provider returned an HTTP error.',
    'provider-timeout': 'The provider request timed out.',
    'provider-invalid-response': 'The provider returned an invalid response.',
    'provider-unsupported': 'This provider is not supported yet.',
    internal: 'The usage provider failed without a public diagnostic.',
  }
  return generic[code]
}

export function publicError(error: unknown, providerId?: ProviderId): PublicUsageError {
  if (error instanceof UsageDashboardError) {
    const result: PublicUsageError = {
      code: error.code,
      message: safeDiagnosticMessage(error.code),
      ...(error.providerId === undefined && providerId !== undefined ? { providerId } : {}),
      ...(error.providerId !== undefined ? { providerId: error.providerId } : {}),
      ...(error.status !== undefined ? { status: error.status } : {}),
    }
    return result
  }

  return {
    code: 'internal',
    message: 'The usage provider failed without a public diagnostic.',
    ...(providerId === undefined ? {} : { providerId }),
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
