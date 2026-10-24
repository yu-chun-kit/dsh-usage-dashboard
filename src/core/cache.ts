import { publicError } from './errors.js'
import { NOOP_USAGE_LOGGER } from './logging.js'
import type { UsageLogger } from './logging.js'
import { normalizeStoredProvider, readStoredProviders, withinSnapshotLimit } from './snapshot-store.js'
import type { UsageSnapshotStore, StoredUsageSnapshots } from './snapshot-store.js'
import type {
  CredentialResolver,
  ProviderAdapter,
  ProviderFetch,
  ProviderId,
  ProviderSnapshot,
  UsageDashboardSettings,
  UsageDashboardSnapshot,
} from './types.js'

export interface UsageCacheOptions {
  readonly now?: () => Date
  readonly maxConcurrent?: number
  readonly logger?: UsageLogger
  readonly snapshotStore?: UsageSnapshotStore
}

interface CacheEntry {
  readonly snapshot: ProviderSnapshot
  readonly fetchedAtMs: number
  readonly expiresAtMs: number
}

type Release = () => void

/** Shared cache with optional host persistence, bounded work and one request per provider. */
export class UsageDashboardCache {
  private readonly adapters: ReadonlyMap<ProviderId, ProviderAdapter>
  private readonly credentials: CredentialResolver
  private readonly fetcher: ProviderFetch
  private readonly settings: UsageDashboardSettings
  private readonly now: () => Date
  private readonly maxConcurrent: number
  private readonly logger: UsageLogger
  private readonly entries = new Map<ProviderId, CacheEntry>()
  private readonly inFlight = new Map<ProviderId, Promise<ProviderSnapshot>>()
  private readonly waiters: Array<() => void> = []
  private active = 0
  private generation = 0
  private readonly snapshotStore?: UsageSnapshotStore
  private readonly scope: string
  private hydration?: Promise<void>
  private persistence: Promise<void> = Promise.resolve()
  private revision = 0
  private persistedRevision = 0

  constructor(
    adapters: readonly ProviderAdapter[],
    credentials: CredentialResolver,
    fetcher: ProviderFetch,
    settings: UsageDashboardSettings,
    options: UsageCacheOptions = {},
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]))
    this.credentials = credentials
    this.fetcher = fetcher
    this.settings = settings
    this.now = options.now ?? (() => new Date())
    this.maxConcurrent = Math.max(1, Math.min(3, Math.floor(options.maxConcurrent ?? 3)))
    this.logger = options.logger ?? NOOP_USAGE_LOGGER
    this.snapshotStore = options.snapshotStore
    this.scope = JSON.stringify(settings)
  }

  async snapshot(providerIds: readonly ProviderId[], force = false, signal?: AbortSignal): Promise<UsageDashboardSnapshot> {
    const generation = this.generation
    await this.restore()
    const ids = [...new Set(providerIds)]
    const effectiveSignal = signal ?? new AbortController().signal
    const providers = await Promise.all(ids.map((id) => this.getProvider(id, force, effectiveSignal)))
    if (generation === this.generation) await this.persist(generation)
    return { providers, generatedAt: this.now().toISOString() }
  }

  /** No provider work, including when another device already has a refresh in flight. */
  async cachedSnapshot(providerIds: readonly ProviderId[]): Promise<UsageDashboardSnapshot> {
    await this.restore()
    const ids = [...new Set(providerIds)]
    const providers = ids.flatMap(id => { const entry = this.entries.get(id); return entry === undefined ? [] : [entry.snapshot] })
    const needsRefresh = ids.some(id => { const entry = this.entries.get(id); return entry === undefined || entry.expiresAtMs <= this.now().getTime() })
    return { providers, generatedAt: this.now().toISOString(), needsRefresh }
  }

  clear(): Promise<void> {
    this.generation += 1
    this.revision += 1
    this.hydration = Promise.resolve()
    this.entries.clear()
    this.inFlight.clear()
    return this.persist(this.generation)
  }

  private restore(): Promise<void> {
    if (this.hydration !== undefined) return this.hydration
    const generation = this.generation
    this.hydration = (async () => {
      if (this.snapshotStore === undefined) return
      try {
        const providers = readStoredProviders(await this.snapshotStore.read(), this.scope)
        if (generation !== this.generation) return
        for (const provider of providers) {
          const adapter = this.adapters.get(provider.providerId)
          if (adapter === undefined || !this.settings.enabledProviders.includes(provider.providerId)) continue
          const snapshot = { ...provider, displayName: adapter.displayName, stability: adapter.stability }
          this.entries.set(provider.providerId, { snapshot, fetchedAtMs: Date.parse(provider.fetchedAt!), expiresAtMs: Date.parse(provider.expiresAt!) })
        }
      } catch { this.logger.warn('snapshot.read-unavailable', { errorCode: 'internal' }) }
    })()
    return this.hydration
  }

  private persist(generation: number): Promise<void> {
    if (this.snapshotStore === undefined) return Promise.resolve()
    this.persistence = this.persistence.then(async () => {
      if (generation !== this.generation || this.revision === this.persistedRevision) return
      const revision = this.revision
      const providers = [...this.entries.values()].map(entry => normalizeStoredProvider(entry.snapshot)).filter((provider): provider is ProviderSnapshot => provider !== undefined && this.settings.enabledProviders.includes(provider.providerId))
      const value: StoredUsageSnapshots = { version: 1, scope: this.scope, providers }
      if (!withinSnapshotLimit(value)) { this.logger.warn('snapshot.limit', { errorCode: 'internal' }); return }
      try {
        await this.snapshotStore!.write(value)
        if (generation === this.generation) this.persistedRevision = revision
      } catch { this.logger.warn('snapshot.write-unavailable', { errorCode: 'internal' }) }
    })
    return this.persistence
  }

  private getProvider(id: ProviderId, force: boolean, signal: AbortSignal): Promise<ProviderSnapshot> {
    const running = this.inFlight.get(id)
    if (running !== undefined) {
      this.logger.debug('cache.single_flight', { providerId: id, cache: 'in-flight' })
      return running
    }
    const entry = this.entries.get(id)
    const nowMs = this.now().getTime()
    if (!force && entry !== undefined && entry.expiresAtMs > nowMs) {
      this.logger.debug('cache.hit', { providerId: id, cache: 'fresh', force: false })
      return Promise.resolve(entry.snapshot)
    }

    this.logger.debug('cache.miss', { providerId: id, cache: force ? 'force' : entry === undefined ? 'empty' : 'expired', force })

    const promise = this.refresh(id, entry, signal, this.generation)
    this.inFlight.set(id, promise)
    void promise.finally(() => {
      if (this.inFlight.get(id) === promise) this.inFlight.delete(id)
    }).catch(() => undefined)
    return promise
  }

  private async refresh(id: ProviderId, previous: CacheEntry | undefined, signal: AbortSignal, generation: number): Promise<ProviderSnapshot> {
    const adapter = this.adapters.get(id)
    if (adapter === undefined) {
      this.logger.error('provider.failure', { providerId: id, status: 'error', errorCode: 'internal', stale: false })
      return this.errorSnapshot(id, 'The requested provider is not registered.', 'error')
    }
    let release: Release | undefined
    const startedAt = this.now().getTime()
    try {
      release = await this.acquire(id)
      const snapshot = await adapter.refresh({
        credentials: this.credentials,
        fetch: this.fetcher,
        settings: this.settings,
        now: this.now,
        logger: this.logger,
      }, signal)
      const fetchedAtMs = this.now().getTime()
      const expiresAtMs = fetchedAtMs + this.settings.refreshTtlMinutes * 60_000
      const withExpiry: ProviderSnapshot = {
        ...snapshot,
        ...(snapshot.state === 'fresh' && snapshot.fetchedAt === undefined ? { fetchedAt: new Date(fetchedAtMs).toISOString() } : {}),
        attemptedAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      }
      if (generation === this.generation) { this.entries.set(id, { snapshot: withExpiry, fetchedAtMs, expiresAtMs }); this.revision += 1 }
      this.logger.info('provider.success', {
        providerId: id,
        adapter: adapter.displayName,
        durationMs: Math.max(0, this.now().getTime() - startedAt),
        status: withExpiry.state,
        metricCount: withExpiry.metrics.length,
      })
      return withExpiry
    } catch (error) {
      const diagnostic = publicError(error, id)
      if (previous !== undefined && (previous.snapshot.state === 'fresh' || previous.snapshot.state === 'stale') && ['provider-http', 'provider-timeout', 'provider-invalid-response', 'internal'].includes(diagnostic.code)) {
        const stale: ProviderSnapshot = {
          ...previous.snapshot,
          state: 'stale',
          warning: diagnostic.message,
          errorCode: diagnostic.code,
          attemptedAt: new Date(startedAt).toISOString(),
        }
        // Other devices must see the failed attempt too, without extending the good data's TTL.
        if (generation === this.generation) { this.entries.set(id, { ...previous, snapshot: stale }); this.revision += 1 }
        this.logger.warn('provider.failure', {
          providerId: id,
          adapter: adapter.displayName,
          durationMs: Math.max(0, this.now().getTime() - startedAt),
          status: 'stale',
          errorCode: diagnostic.code,
          httpStatus: diagnostic.status,
          stale: true,
        })
        return stale
      }
      this.logger.warn('provider.failure', {
        providerId: id,
        adapter: adapter.displayName,
        durationMs: Math.max(0, this.now().getTime() - startedAt),
        status: 'error',
        errorCode: diagnostic.code,
        httpStatus: diagnostic.status,
        stale: false,
      })
      const state = diagnostic.code === 'provider-unsupported' ? 'unsupported' : diagnostic.code === 'credential-missing' ? 'needs-configuration' : 'error'
      if (generation === this.generation && this.entries.delete(id)) this.revision += 1
      return { ...this.errorSnapshot(id, diagnostic.message, state), errorCode: diagnostic.code, attemptedAt: new Date(startedAt).toISOString() }
    } finally {
      release?.()
    }
  }

  private errorSnapshot(id: ProviderId, message: string, state: ProviderSnapshot['state']): ProviderSnapshot {
    const adapter = this.adapters.get(id)
    return {
      providerId: id,
      displayName: adapter?.displayName ?? id,
      stability: adapter?.stability ?? 'experimental',
      state,
      metrics: [],
      warning: message,
    }
  }

  private acquire(providerId: ProviderId): Promise<Release> {
    if (this.active < this.maxConcurrent) {
      this.active += 1
      return Promise.resolve(() => this.release())
    }
    this.logger.debug('concurrency.queued', { providerId, concurrency: this.active, queueDepth: this.waiters.length + 1 })
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    next?.()
  }
}

export function providerIdsFromSettings(settings: UsageDashboardSettings, requested?: readonly ProviderId[]): readonly ProviderId[] {
  return requested === undefined ? settings.enabledProviders : requested
}

export function ttlMs(settings: UsageDashboardSettings): number {
  return settings.refreshTtlMinutes * 60_000
}
