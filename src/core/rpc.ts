import { publicError, UsageDashboardError } from './errors.js'
import { UsageDashboardCache } from './cache.js'
import { createDefaultAdapters } from './adapters.js'
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_SCHEMA } from './settings.js'
import { globalProviderFetch } from './http.js'
import { NOOP_USAGE_LOGGER } from './logging.js'
import type { UsageLogger } from './logging.js'
import { CREDENTIAL_REFERENCES, describeKnownReference, validateSecretCandidate } from './credentials.js'
import type { CredentialStatus, CredentialStatusResolver } from './credentials.js'
import { normalizeActivity } from './activity.js'
import type { UsageActivity, UsageActivityStore } from './activity.js'
import type { UsageSnapshotStore } from './snapshot-store.js'
import { PROVIDER_IDS } from './types.js'
import type {
  CredentialResolver,
  ProviderAdapter,
  ProviderFetch,
  ProviderId,
  PublicUsageError,
  UsageDashboardSettings,
} from './types.js'

export const USAGE_DASHBOARD_CHANNEL = '/usage-dashboard'
export const USAGE_RPC_ENDPOINTS = ['snapshot', 'settings/read', 'settings/write', 'credential/write'] as const
export type UsageRpcEndpoint = (typeof USAGE_RPC_ENDPOINTS)[number]

export type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PublicUsageError }

export interface UsageRpcConnection {
  rpc: {
    handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>, options: { authority: 'loopback' }): unknown
  }
}

export interface CredentialStore {
  store(reference: string, value: string, signal?: AbortSignal): Promise<void>
}

export interface UsageDashboardServiceOptions {
  readonly credentials: CredentialResolver
  readonly credentialStore?: CredentialStore
  readonly fetcher?: ProviderFetch
  readonly adapters?: readonly ProviderAdapter[]
  readonly settings?: unknown
  readonly now?: () => Date
  readonly credentialStatus?: CredentialStatusResolver
  readonly logger?: UsageLogger
  readonly activityStore?: UsageActivityStore
  readonly snapshotStore?: UsageSnapshotStore
}

export interface UsageDashboardService {
  readonly endpoints: readonly UsageRpcEndpoint[]
  readonly settingsSchema: typeof SETTINGS_SCHEMA
  settings(): UsageDashboardSettings
  handle(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
  observeCredentialUpdate(reference: string): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badRequest(message: string): UsageDashboardError {
  return new UsageDashboardError('bad-request', message)
}

function validateProviderIds(value: unknown): readonly ProviderId[] {
  if (!Array.isArray(value)) throw badRequest('providerIds must be an array.')
  const ids: ProviderId[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(candidate)) throw badRequest('providerIds contains an unsupported provider.')
    if (!ids.includes(candidate as ProviderId)) ids.push(candidate as ProviderId)
  }
  return ids
}

async function credentialStatuses(resolver?: CredentialStatusResolver, activity: UsageActivity = {}): Promise<readonly CredentialStatus[]> {
  const statuses: CredentialStatus[] = []
  for (const references of Object.values(CREDENTIAL_REFERENCES)) {
    for (const reference of references) {
      const info = resolver === undefined ? { configured: false, writable: false } : await resolver(reference.reference)
      // Whitelist fields: a third-party resolver must never leak extra secret properties.
      const source = ['models', 'env', 'file', 'session', 'keychain', 'vault'].includes(info.source ?? '') ? info.source : undefined
      statuses.push({ ...reference, configured: info.configured === true, writable: info.writable === true, source, updatedAt: activity.credentialUpdatedAt?.[reference.reference] })
    }
  }
  return statuses
}

export function createUsageDashboardService(options: UsageDashboardServiceOptions): UsageDashboardService {
  let currentSettings = normalizeSettings(options.settings ?? DEFAULT_SETTINGS)
  const adapters = options.adapters ?? createDefaultAdapters()
  const logger = options.logger ?? NOOP_USAGE_LOGGER
  const now = options.now ?? (() => new Date())
  let requestSequence = 0
  let latestManualRequest = 0
  const cacheOptions = { now, maxConcurrent: 3, logger, snapshotStore: options.snapshotStore }
  let cache = new UsageDashboardCache(adapters, options.credentials, options.fetcher ?? globalProviderFetch(), currentSettings, cacheOptions)
  let activity: UsageActivity = {}
  const readActivity = async (): Promise<UsageActivity> => {
    if (options.activityStore !== undefined) {
      try { activity = normalizeActivity(await options.activityStore.read()) } catch { /* Preserve the in-memory fallback. */ }
    }
    return activity
  }
  const updateActivity = async (change: (current: UsageActivity) => UsageActivity): Promise<UsageActivity> => {
    activity = normalizeActivity(change(activity))
    if (options.activityStore !== undefined) {
      try { activity = normalizeActivity(await options.activityStore.update(current => normalizeActivity(change(normalizeActivity(current))))) }
      catch { logger.warn('activity.store-unavailable', { errorCode: 'internal' }) }
    }
    return activity
  }
  const observeCredentialUpdate = async (reference: string): Promise<void> => {
    if (describeKnownReference(reference) === undefined) return
    await cache.clear()
    const at = now().toISOString()
    await updateActivity(current => ({ ...current, credentialUpdatedAt: { ...current.credentialUpdatedAt, [reference]: at } }))
  }

  return {
    endpoints: USAGE_RPC_ENDPOINTS,
    settingsSchema: SETTINGS_SCHEMA,
    settings: () => currentSettings,
    observeCredentialUpdate,
    async handle(endpoint, payload, signal): Promise<RpcResult<unknown>> {
      const requestId = `ud-${Date.now().toString(36)}-${++requestSequence}`
      const sequence = requestSequence
      const startedAt = now().getTime()
      if (!(USAGE_RPC_ENDPOINTS as readonly string[]).includes(endpoint)) {
        logger.warn('rpc.reject', { requestId, endpoint, authority: 'loopback', errorCode: 'bad-request' })
        return { ok: false, error: publicError(new UsageDashboardError('bad-request', 'The usage RPC endpoint is not allowed.')) }
      }
      logger.debug('rpc.start', { requestId, endpoint, authority: 'loopback' })
      try {
        if (endpoint === 'snapshot') {
          if (payload !== undefined && !isRecord(payload)) throw badRequest('snapshot payload must be an object.')
          const body = isRecord(payload) ? payload : {}
          const providerIds = body.providerIds === undefined ? currentSettings.enabledProviders : validateProviderIds(body.providerIds)
          const force = body.force === true
          if (body.cacheOnly !== undefined && typeof body.cacheOnly !== 'boolean') throw badRequest('cacheOnly must be a boolean.')
          if (body.cacheOnly === true) {
            if (force) throw badRequest('cacheOnly cannot force a refresh.')
            const snapshot = await cache.cachedSnapshot(providerIds)
            return { ok: true, value: { ...snapshot, activity: await readActivity() } }
          }
          const manual = force && body.reason === 'manual'
          const requestedAt = now().toISOString()
          if (manual) latestManualRequest = sequence
          await readActivity()
          if (manual) await updateActivity(current => ({ ...current, lastManualRefresh: { requestedAt } }))
          const snapshot = await cache.snapshot(providerIds, force, signal)
          if (manual && latestManualRequest === sequence) {
            const failed = snapshot.providers.filter(provider => provider.state !== 'fresh' && provider.state !== 'unsupported').length
            const outcome = failed === 0 ? 'complete' : failed === snapshot.providers.length ? 'failed' : 'partial'
            // A slower request must not overwrite a newer refresh's activity.
            await updateActivity(current => current.lastManualRefresh?.requestedAt === requestedAt
              ? { ...current, lastManualRefresh: { requestedAt, completedAt: now().toISOString(), outcome } }
              : current)
          }
          const value = { ...snapshot, activity }
          logger.info('rpc.success', { requestId, endpoint, durationMs: Math.max(0, now().getTime() - startedAt), status: 'ok' })
          return { ok: true, value }
        }
        if (endpoint === 'settings/read') {
          const value = { settings: currentSettings, schema: SETTINGS_SCHEMA, credentials: await credentialStatuses(options.credentialStatus, await readActivity()) }
          logger.info('rpc.success', { requestId, endpoint, durationMs: Math.max(0, now().getTime() - startedAt), status: 'ok' })
          return { ok: true, value }
        }
        if (endpoint === 'credential/write') {
          if (!isRecord(payload)) throw badRequest('credential/write payload must be an object.')
          const reference = payload.reference
          if (typeof reference !== 'string') throw badRequest('reference must be a string.')
          const known = describeKnownReference(reference)
          if (known === undefined) {
            logger.warn('rpc.failure', { requestId, endpoint, durationMs: Math.max(0, now().getTime() - startedAt), status: 'error', errorCode: 'bad-request', reference })
            throw badRequest('Unknown credential reference.')
          }
          const secret = validateSecretCandidate(payload.value)
          if (secret === undefined) {
            logger.warn('rpc.failure', { requestId, endpoint, durationMs: Math.max(0, now().getTime() - startedAt), status: 'error', errorCode: 'bad-request', reference })
            throw badRequest('The credential value is invalid. Enter 8..4096 characters with no line breaks.')
          }
          if (options.credentialStore === undefined) {
            logger.warn('rpc.failure', { requestId, endpoint, durationMs: Math.max(0, now().getTime() - startedAt), status: 'error', errorCode: 'credential-not-writable', reference })
            throw new UsageDashboardError('credential-not-writable', 'The Harness credential store is not writable from this panel. Add the reference in Harness credential management instead.', { providerId: known.providerId })
          }
          try {
            await options.credentialStore.store(reference, secret, signal)
          } catch (error) {
            // Never include the secret, its length, or the raw error text in logs/responses.
            logger.warn('rpc.failure', { requestId, endpoint, durationMs: Math.max(0, now().getTime() - startedAt), status: 'error', errorCode: 'credential-rejected', reference })
            throw new UsageDashboardError('credential-rejected', 'The Harness credential store rejected the value.', { providerId: known.providerId })
          }
          // Drop cached snapshots so the next read uses the new credential.
          // The secret itself is not cached, logged, or returned.
          await observeCredentialUpdate(reference)
          const statuses = await credentialStatuses(options.credentialStatus, activity)
          const saved = statuses.find((item) => item.reference === reference)
          logger.info('rpc.success', { requestId, endpoint, durationMs: Math.max(0, now().getTime() - startedAt), status: 'ok', reference })
          return { ok: true, value: { reference, configured: saved?.configured ?? true, writable: saved?.writable ?? false, updatedAt: saved?.updatedAt } }
        }
        if (!isRecord(payload)) throw badRequest('settings/write payload must be an object.')
        await cache.clear()
        currentSettings = normalizeSettings(payload.settings)
        cache = new UsageDashboardCache(adapters, options.credentials, options.fetcher ?? globalProviderFetch(), currentSettings, cacheOptions)
        logger.info('rpc.success', { requestId, endpoint, durationMs: Math.max(0, now().getTime() - startedAt), status: 'ok' })
        return { ok: true, value: currentSettings }
      } catch (error) {
        const diagnostic = publicError(error)
        logger.warn('rpc.failure', {
          requestId,
          endpoint,
          durationMs: Math.max(0, now().getTime() - startedAt),
          status: 'error',
          errorCode: diagnostic.code,
          httpStatus: diagnostic.status,
        })
        return { ok: false, error: diagnostic }
      }
    },
  }
}

export interface RegisteredUsageRpc {
  readonly channel: typeof USAGE_DASHBOARD_CHANNEL
  readonly endpoints: readonly UsageRpcEndpoint[]
  readonly authority: 'loopback'
  readonly dispose?: () => void
}

export function registerLoopbackRpc(connection: UsageRpcConnection, service: UsageDashboardService): RegisteredUsageRpc {
  const handler = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>> => service.handle(endpoint, payload, signal)
  const maybeDispose = connection.rpc.handle(USAGE_DASHBOARD_CHANNEL, handler, { authority: 'loopback' })
  return {
    channel: USAGE_DASHBOARD_CHANNEL,
    endpoints: service.endpoints,
    authority: 'loopback',
    ...(typeof maybeDispose === 'function' ? { dispose: maybeDispose as () => void } : {}),
  }
}
