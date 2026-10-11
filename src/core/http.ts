import { UsageDashboardError } from './errors.js'
import { NOOP_USAGE_LOGGER } from './logging.js'
import type { UsageLogger } from './logging.js'
import type { ProviderFetch, ProviderId, ProviderRequest } from './types.js'

export const MAX_RESPONSE_BYTES = 256 * 1024
export const PROVIDER_TIMEOUT_MS = 10_000

export interface EndpointPolicy {
  readonly providerId: ProviderId
  readonly hostname: string
  readonly pathname: string | { readonly prefix: string }
}

function pathAllowed(pathname: string, expected: EndpointPolicy['pathname']): boolean {
  return typeof expected === 'string' ? pathname === expected : pathname.startsWith(expected.prefix)
}

export function assertAllowedEndpoint(urlText: string, policy: EndpointPolicy): URL {
  let url: URL
  try {
    url = new URL(urlText)
  } catch {
    throw new UsageDashboardError('endpoint-not-allowed', 'The provider endpoint is not a valid URL.', { providerId: policy.providerId })
  }
  if (url.protocol !== 'https:' || url.hostname !== policy.hostname || !pathAllowed(url.pathname, policy.pathname)) {
    throw new UsageDashboardError('endpoint-not-allowed', 'The provider endpoint is outside its fixed allowlist.', { providerId: policy.providerId })
  }
  return url
}

function mergeSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    },
  }
}

export async function requestJson<T>(
  fetcher: ProviderFetch,
  request: Omit<ProviderRequest, 'signal'>,
  policy: EndpointPolicy,
  signal: AbortSignal,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  logger: UsageLogger = NOOP_USAGE_LOGGER,
): Promise<T> {
  let url: URL
  try {
    url = assertAllowedEndpoint(request.url, policy)
  } catch (error) {
    logger.warn('http.blocked', {
      providerId: policy.providerId,
      endpoint: policy.hostname,
      endpointPath: typeof policy.pathname === 'string' ? policy.pathname : policy.pathname.prefix,
      errorCode: error instanceof UsageDashboardError ? error.code : 'endpoint-not-allowed',
    })
    throw error
  }
  const startedAt = Date.now()
  logger.debug('http.start', {
    providerId: policy.providerId,
    endpoint: policy.hostname,
    endpointPath: url.pathname,
    timeoutMs,
  })
  const merged = mergeSignal(signal, timeoutMs)
  try {
    let response
    try {
      response = await fetcher({ ...request, url: url.toString(), signal: merged.signal })
    } catch (error) {
      if (merged.timedOut()) {
        logger.warn('http.failure', {
          providerId: policy.providerId,
          endpoint: policy.hostname,
          durationMs: Math.max(0, Date.now() - startedAt),
          status: 'timeout',
          errorCode: 'provider-timeout',
        })
        throw new UsageDashboardError('provider-timeout', 'The provider request timed out.', { providerId: policy.providerId })
      }
      logger.warn('http.failure', {
        providerId: policy.providerId,
        endpoint: policy.hostname,
        durationMs: Math.max(0, Date.now() - startedAt),
        status: 'transport-error',
        errorCode: 'provider-http',
      })
      throw new UsageDashboardError('provider-http', 'The provider could not be reached.', { providerId: policy.providerId })
    }
    const contentLength = response.headers?.['content-length']
    if (contentLength !== undefined && Number(contentLength) > MAX_RESPONSE_BYTES) {
      logger.warn('http.failure', { providerId: policy.providerId, endpoint: policy.hostname, status: 'too-large', errorCode: 'provider-invalid-response', responseBytes: Number(contentLength) })
      throw new UsageDashboardError('provider-invalid-response', 'The provider response is too large.', { providerId: policy.providerId })
    }
    if (response.status === 401 || response.status === 403) {
      logger.warn('http.failure', { providerId: policy.providerId, endpoint: policy.hostname, status: 'credential-rejected', httpStatus: response.status, errorCode: 'credential-rejected' })
      throw new UsageDashboardError('credential-rejected', 'The provider rejected the configured credential.', { providerId: policy.providerId, status: response.status })
    }
    if (response.status === 429) {
      logger.warn('http.failure', { providerId: policy.providerId, endpoint: policy.hostname, status: 'rate-limited', httpStatus: response.status, errorCode: 'provider-http' })
      throw new UsageDashboardError('provider-http', 'The provider rate-limited the usage check.', { providerId: policy.providerId, status: response.status })
    }
    if (response.status < 200 || response.status >= 300) {
      logger.warn('http.failure', { providerId: policy.providerId, endpoint: policy.hostname, status: 'http-error', httpStatus: response.status, errorCode: 'provider-http' })
      throw new UsageDashboardError('provider-http', 'The provider returned an HTTP error.', { providerId: policy.providerId, status: response.status })
    }
    const text = await response.text()
    const responseBytes = new TextEncoder().encode(text).byteLength
    if (responseBytes > MAX_RESPONSE_BYTES) {
      logger.warn('http.failure', { providerId: policy.providerId, endpoint: policy.hostname, status: 'too-large', errorCode: 'provider-invalid-response', responseBytes })
      throw new UsageDashboardError('provider-invalid-response', 'The provider response is too large.', { providerId: policy.providerId })
    }
    try {
      const value = JSON.parse(text) as T
      logger.info('http.success', { providerId: policy.providerId, endpoint: policy.hostname, durationMs: Math.max(0, Date.now() - startedAt), status: 'ok', httpStatus: response.status, responseBytes })
      return value
    } catch {
      logger.warn('http.failure', { providerId: policy.providerId, endpoint: policy.hostname, status: 'malformed-json', errorCode: 'provider-invalid-response', responseBytes })
      throw new UsageDashboardError('provider-invalid-response', 'The provider returned malformed JSON.', { providerId: policy.providerId })
    }
  } finally {
    merged.dispose()
  }
}

export function globalProviderFetch(): ProviderFetch {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      signal: request.signal,
      redirect: 'error',
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
    return {
      status: response.status,
      headers,
      text: () => response.text(),
    }
  }
}
