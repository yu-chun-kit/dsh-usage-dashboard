import type { RpcResult, UsageDashboardService } from './rpc.js'

/**
 * HTTP surface for the dashboard, mounted as exact WebServer routes.
 *
 * DSH 0.1.5 no longer exposes the legacy generic Connection RPC channel
 * (`/usage-dashboard`) to third-party plugins: `connection.rpc.handle` still
 * returns a disposer, but the WebServer prefix route it used to create is no
 * longer reachable, so every call answered HTTP 405 and the dashboard could
 * not read usage or credential status. Exact routes under `/api/...` are the
 * supported replacement and are what working in-box plugins use.
 */

/** Route prefix shared by every dashboard endpoint. */
export const DASHBOARD_HTTP_PREFIX = '/api/usage-dashboard'

/** Request ceiling for credential writes and settings payloads. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

export interface DashboardHttpRequest {
  readonly method?: string | undefined
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined
  on?(event: string, listener: (...args: readonly unknown[]) => void): unknown
}

export interface DashboardHttpResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(body?: string | undefined): unknown
}

export interface DashboardHttpRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (request: DashboardHttpRequest, response: DashboardHttpResponse) => Promise<void>
}

/** Host-provided trust check (DSH Connection's own `/api` fence). 401/403, or undefined when trusted. */
export type DashboardRequestRejection = (request: unknown) => number | undefined

export interface DashboardHttpRouteOptions {
  readonly rejection?: DashboardRequestRejection | undefined
}

interface EndpointRoute {
  readonly path: string
  readonly endpoint: string
  readonly payloadFromBody: boolean
}

const ENDPOINT_ROUTES: readonly EndpointRoute[] = [
  { path: `${DASHBOARD_HTTP_PREFIX}/snapshot`, endpoint: 'snapshot', payloadFromBody: true },
  { path: `${DASHBOARD_HTTP_PREFIX}/settings`, endpoint: 'settings/read', payloadFromBody: false },
  { path: `${DASHBOARD_HTTP_PREFIX}/settings-write`, endpoint: 'settings/write', payloadFromBody: true },
  { path: `${DASHBOARD_HTTP_PREFIX}/credential`, endpoint: 'credential/write', payloadFromBody: true },
]

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

function sendJson(response: DashboardHttpResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...JSON_HEADERS, ...(status === 405 ? { allow: 'POST' } : {}) })
  response.end(JSON.stringify(body))
}

function sendText(response: DashboardHttpResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  response.end(text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIPv4Loopback(address: string): boolean {
  const parts = address.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isIPv4Loopback(hostname)
}

function headerValue(request: DashboardHttpRequest, name: string): string | undefined {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/**
 * Fallback fence used only when Host Connection is unavailable: the request
 * must arrive on a loopback socket with a loopback Host header, and must not be
 * a cross-site browser request.
 */
function isLoopbackRequest(request: DashboardHttpRequest): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = headerValue(request, 'host')
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  if (headerValue(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(request, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function readBody(request: DashboardHttpRequest): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (typeof request.on !== 'function') {
      resolve('')
      return
    }
    const chunks: string[] = []
    let bytes = 0
    request.on('data', (chunk: unknown) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      bytes += text.length
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('body too large'))
        return
      }
      chunks.push(text)
    })
    request.on('end', () => resolve(chunks.join('')))
    request.on('error', () => reject(new Error('body read failed')))
  })
}

async function payloadOf(request: DashboardHttpRequest, route: EndpointRoute): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; text: string }> {
  if (!route.payloadFromBody) return { ok: true, payload: undefined }
  const contentType = headerValue(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') return { ok: false, status: 415, text: 'content type must be application/json' }
  let text: string
  try {
    text = await readBody(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'body read failed'
    return { ok: false, status: message === 'body too large' ? 413 : 400, text: message }
  }
  if (text.trim().length === 0) return { ok: true, payload: {} }
  try {
    return { ok: true, payload: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, text: 'body is not JSON' }
  }
}

/**
 * Build the exact-route list for one dashboard service.
 *
 * Every handler is fenced before any work happens: Connection's own rejection
 * (trusted Host/Origin + browser session) when available, otherwise a strict
 * loopback check. Responses are always the `RpcResult` shape the client
 * already understands, so no secret value is ever echoed back.
 */
export function createDashboardHttpRoutes(service: UsageDashboardService, options: DashboardHttpRouteOptions = {}): readonly DashboardHttpRoute[] {
  const rejection = options.rejection
  return ENDPOINT_ROUTES.map((route) => ({
    kind: 'exact' as const,
    path: route.path,
    handler: async (request: DashboardHttpRequest, response: DashboardHttpResponse): Promise<void> => {
      const rejected = rejection === undefined ? (isLoopbackRequest(request) ? undefined : 403) : rejection(request)
      if (rejected !== undefined) {
        sendText(response, rejected, rejected === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (request.method !== 'POST') {
        sendText(response, 405, 'method not allowed')
        return
      }
      const payload = await payloadOf(request, route)
      if (!payload.ok) {
        sendText(response, payload.status, payload.text)
        return
      }
      let result: RpcResult<unknown>
      try {
        result = await service.handle(route.endpoint, payload.payload)
      } catch {
        sendJson(response, 500, { ok: false, error: { code: 'internal', message: 'The usage dashboard failed to handle the request.' } })
        return
      }
      sendJson(response, 200, result)
    },
  }))
}

/** Endpoint path lookup shared with the browser half (`settings/read` → `settings`). */
export const DASHBOARD_HTTP_PATHS: Readonly<Record<string, string>> = Object.fromEntries(
  ENDPOINT_ROUTES.map((route) => [route.endpoint, route.path.slice(DASHBOARD_HTTP_PREFIX.length + 1)]),
)
