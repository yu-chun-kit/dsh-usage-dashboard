import { registerLoopbackRpc, createUsageDashboardService, USAGE_DASHBOARD_CHANNEL } from '../core/rpc.js'
import { createDashboardHttpRoutes, DASHBOARD_HTTP_PREFIX } from '../core/routes.js'
import type { DashboardHttpRoute } from '../core/routes.js'
import type { UsageRpcConnection } from '../core/rpc.js'
import { globalProviderFetch } from '../core/http.js'
import type { CredentialResolver, ProviderFetch } from '../core/types.js'
import type { CredentialStatusResolver } from '../core/credentials.js'
import { createUsageLogger } from '../core/logging.js'
import type { HostLoggerLike } from '../core/logging.js'
import { HOST_CREDENTIAL_RECORDS, hasSecret } from '../core/credentials.js'
import { normalizeActivity } from '../core/activity.js'
import type { UsageActivityStore } from '../core/activity.js'
import type { UsageSnapshotStore } from '../core/snapshot-store.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface UsageDashboardHostContext {
  readonly connection?: UsageRpcConnection | ConnectionLike
  readonly webServer?: WebServerLike
  readonly credentials?: CredentialResolver | HostCredentialService
  readonly providerFetch?: ProviderFetch
  readonly settings?: unknown
  readonly now?: () => Date
  readonly logger?: HostLoggerLike
  readonly effect?: (callback: () => () => void, label?: string) => unknown
  readonly on?: (event: string, listener: (subject: string) => Promise<void>) => unknown
}

/** Minimal WebServer surface used to mount exact routes. */
export interface WebServerLike {
  register(route: DashboardHttpRoute): unknown
}

/** Connection surface used by the legacy generic channel and the shared `/api` fence. */
export interface ConnectionLike {
  readonly rpc?: {
    handle?: (
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
      options: { authority: 'loopback' },
    ) => unknown
  }
  readonly requestRejection?: (request: unknown) => number | undefined
}

/** Best-effort registration diagnostics for hosts without a visible stdout log. */
export const BOOT_DIAGNOSTIC_FILE = join(tmpdir(), 'dsh-usage-dashboard-boot.log')

/**
 * Host-half service lookup.
 *
 * Cordis 0.1.5 gates direct service reads behind the plugin's declared
 * `inject` and a rejected read throws; `ctx.get(name)` is the documented
 * un-gated accessor. Property access stays as a best-effort fallback for older
 * harnesses, and a silent failure here is what previously left the browser
 * half talking to a route that was never mounted.
 */
interface HostServiceLookup {
  get?<T = unknown>(name: string): T | undefined
}

function lookupService<T>(ctx: UsageDashboardHostContext & HostServiceLookup, name: string): T | undefined {
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get<T>(name)
      if (value !== undefined) return value
    } catch {
      // Fall through to property access.
    }
  }
  try {
    return (ctx as unknown as Record<string, T | undefined>)[name]
  } catch {
    return undefined
  }
}

/** Shape returned by the Harness credential service (`resolve(ref) -> { value, source }`). */
export interface HostCredentialService {
  resolve(reference: string, signal?: AbortSignal): Promise<string | { readonly value?: string } | undefined>
  describe?(reference: string): Promise<{ readonly configured: boolean; readonly source?: string; readonly writable: boolean }>
  store?(reference: string, value: string, signal?: AbortSignal): Promise<void>
  save?(reference: string, value: string, signal?: AbortSignal): Promise<void>
  set?(reference: string, value: string, signal?: AbortSignal): Promise<void>
  write?(reference: string, value: string, signal?: AbortSignal): Promise<void>
  readRecord?(key: string): Promise<{ readonly kind: string; readonly key?: string; readonly payload?: unknown } | undefined>
  describeRecord?(key: string): Promise<{ readonly configured: boolean; readonly kind?: string; readonly writable: boolean }>
  modifyRecord?(key: string, mutate: (current: { readonly kind: string; readonly payload?: unknown } | undefined) => Promise<{ readonly kind: 'grant'; readonly payload: unknown }>): Promise<unknown>
}

const EMPTY_CREDENTIALS: CredentialResolver = {
  resolve: async () => undefined,
}

function credentialResolver(input: UsageDashboardHostContext['credentials']): CredentialResolver {
  if (input === undefined) return EMPTY_CREDENTIALS
  return {
    resolve: async (reference, signal) => {
      const hit = await input.resolve(reference, signal)
      const direct = typeof hit === 'string' ? hit : hit?.value
      if (hasSecret(direct)) return direct
      const key = HOST_CREDENTIAL_RECORDS[reference]
      const record = key !== undefined && 'readRecord' in input ? await input.readRecord?.(key) : undefined
      // Opaque OAuth grants and arbitrary record addresses are never interpreted.
      return record?.kind === 'api-key' && hasSecret(record.key) ? record.key : undefined
    },
  }
}

function credentialStatusResolver(input: UsageDashboardHostContext['credentials']): CredentialStatusResolver | undefined {
  if (input === undefined || !('describe' in input) || input.describe === undefined) return undefined
  return async (reference) => {
    const direct = await input.describe?.(reference) ?? { configured: false, writable: false }
    if (direct.configured) return direct
    const key = HOST_CREDENTIAL_RECORDS[reference]
    const record = key !== undefined && 'describeRecord' in input ? await input.describeRecord?.(key) : undefined
    return record?.configured && record.kind === 'api-key' ? { ...direct, configured: true, source: 'models' } : direct
  }
}

const ACTIVITY_RECORD_KEY = 'dsh-usage-dashboard/activity'
const SNAPSHOTS_RECORD_KEY = 'dsh-usage-dashboard/snapshots'

/** Reuse DSH's atomic record API; only the dedicated display-snapshot key is written. */
function snapshotStore(input: UsageDashboardHostContext['credentials']): UsageSnapshotStore | undefined {
  if (input === undefined || !('readRecord' in input) || !input.readRecord || !input.modifyRecord) return undefined
  const service = input
  return {
    read: async () => { const record = await service.readRecord?.(SNAPSHOTS_RECORD_KEY); return record?.kind === 'grant' ? record.payload : undefined },
    write: async value => { await service.modifyRecord?.(SNAPSHOTS_RECORD_KEY, async () => ({ kind: 'grant', payload: value })) },
  }
}

function activityStore(input: UsageDashboardHostContext['credentials']): UsageActivityStore | undefined {
  if (input === undefined || !('readRecord' in input) || !input.readRecord || !input.modifyRecord) return undefined
  const service = input
  return {
    read: async () => {
      const stored = await service.readRecord?.(ACTIVITY_RECORD_KEY)
      return normalizeActivity(stored?.kind === 'grant' ? stored.payload : undefined)
    },
    update: async change => {
      let next = normalizeActivity(undefined)
      await service.modifyRecord?.(ACTIVITY_RECORD_KEY, async stored => {
        next = normalizeActivity(change(normalizeActivity(stored?.kind === 'grant' ? stored.payload : undefined)))
        return { kind: 'grant', payload: next }
      })
      return next
    },
  }
}

/**
 * Probe the host credential service for a write method without ever reading a secret.
 * Supports store/save/set/write spellings; returns undefined when the host is read-only.
 */
function credentialStore(input: UsageDashboardHostContext['credentials']): { store(reference: string, value: string, signal?: AbortSignal): Promise<void> } | undefined {
  if (input === undefined || typeof input === 'function') return undefined
  const service = input as HostCredentialService
  const candidate = service.store ?? service.save ?? service.set ?? service.write
  if (typeof candidate !== 'function') return undefined
  return {
    store: async (reference, value, signal) => {
      await (candidate as (reference: string, value: string, signal?: AbortSignal) => Promise<void>).call(service, reference, value, signal)
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the dashboard settings from the Cordis plugin row's `config`.
 *
 * Accepted shapes:
 * - `config.settings` — explicit settings envelope
 * - `config` directly — when the plugin row places `enabledProviders` at the top
 */
function configSettings(config: unknown): unknown {
  if (!isRecord(config)) return undefined
  return isRecord(config.settings) ? config.settings : config
}

/**
 * Append one diagnostic line so a registration failure is visible without stdout.
 * The write is lazy and silent: a host that blocks Node builtins must not lose
 * its routes over a diagnostic.
 */
async function recordBootOutcome(notes: readonly string[]): Promise<void> {
  try {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(BOOT_DIAGNOSTIC_FILE, `${JSON.stringify({ at: new Date().toISOString(), notes })}\n`)
  } catch {
    // Best-effort only.
  }
}

/**
 * Host half: mounts the dashboard's exact `/api/...` routes (the supported
 * DSH 0.1.5 surface) and, for older harnesses, the legacy loopback Connection
 * RPC channel. Credential values still move only through the host credential
 * service and are never echoed to the browser.
 */
export function applyHost(ctx: UsageDashboardHostContext, config?: unknown): (() => void) | undefined {
  const lookup = ctx as UsageDashboardHostContext & HostServiceLookup
  const webServer = lookupService<WebServerLike>(lookup, 'webServer')
  const connection = lookupService<ConnectionLike>(lookup, 'connection')
  const credentials = lookupService<UsageDashboardHostContext['credentials']>(lookup, 'credentials')
  const logger = createUsageLogger(lookupService<HostLoggerLike>(lookup, 'logger'))
  const settings = configSettings(config) ?? lookupService<unknown>(lookup, 'settings')

  const dashboardService = createUsageDashboardService({
    credentials: credentialResolver(credentials),
    credentialStore: credentialStore(credentials),
    fetcher: lookupService<ProviderFetch>(lookup, 'providerFetch') ?? globalProviderFetch(),
    settings,
    now: lookupService<() => Date>(lookup, 'now'),
    credentialStatus: credentialStatusResolver(credentials),
    activityStore: activityStore(credentials),
    snapshotStore: snapshotStore(credentials),
    logger,
  })

  const notes: string[] = []
  const disposers: Array<() => void> = []
  if (typeof ctx.on === 'function') {
    for (const event of ['credentials/reference-updated', 'credentials/record-updated']) {
      const dispose = ctx.on(event, async subject => {
        const reference = event === 'credentials/reference-updated' ? subject : Object.entries(HOST_CREDENTIAL_RECORDS).find(([, key]) => key === subject)?.[0]
        if (reference !== undefined) await dashboardService.observeCredentialUpdate(reference)
      })
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
  }
  const rejection = connection?.requestRejection
  const routes = createDashboardHttpRoutes(
    dashboardService,
    rejection === undefined || connection === undefined ? {} : { rejection: (request) => rejection.call(connection, request) },
  )

  if (webServer !== undefined && typeof webServer.register === 'function') {
    for (const route of routes) {
      try {
        const dispose = webServer.register(route)
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
        notes.push(`route:${route.path}`)
      } catch {
        notes.push(`route-failed:${route.path}`)
      }
    }
  } else {
    notes.push('no-webServer')
  }

  // Modern Connection supplies the request fence used by the exact API routes.
  // Its generic RPC registrar no longer enforces the old authority option.
  // Retain the legacy channel only for older, non-fenced Connection adapters.
  if (connection?.requestRejection !== undefined) {
    notes.push('rpc-skipped:authenticated-exact-api')
  } else if (connection !== undefined && typeof connection.rpc?.handle === 'function') {
    try {
      const registration = registerLoopbackRpc(connection as UsageRpcConnection, dashboardService)
      if (typeof registration.dispose === 'function') disposers.push(registration.dispose)
      notes.push(`rpc-channel:${USAGE_DASHBOARD_CHANNEL}`)
    } catch {
      notes.push('rpc-failed')
    }
  } else {
    notes.push('no-connection')
  }

  void recordBootOutcome(notes)
  logger.info('rpc.registered', { endpoint: DASHBOARD_HTTP_PREFIX, authority: 'loopback' })

  const dispose = (): void => {
    for (const disposer of [...disposers].reverse()) {
      try {
        disposer()
      } catch {
        // Disposal is best-effort; a stale route is replaced on the next activation.
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-usage-dashboard: /api routes')
    return undefined
  }
  return dispose
}

export const hostEntry = {
  id: 'dsh-usage-dashboard',
  rpc: { channel: USAGE_DASHBOARD_CHANNEL, authority: 'loopback' as const },
  http: { prefix: DASHBOARD_HTTP_PREFIX },
}

/** Wait for all three services; capturing missing auth/credentials at startup breaks LAN clients. */
export const inject = ['webServer', 'connection', 'credentials'] as const

export default applyHost
