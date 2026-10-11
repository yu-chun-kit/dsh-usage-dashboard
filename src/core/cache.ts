import { publicError } from './errors.js'
import { NOOP_USAGE_LOGGER } from './logging.js'
import type { UsageLogger } from './logging.js'
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
}

interface CacheEntry {
  readonly snapshot: ProviderSnapshot
  readonly fetchedAtMs: number
  readonly expiresAtMs: number
}

type Release = () => void

/** In-memory cache with bounded provider work and one request per provider. */
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
  }

  async snapshot(providerIds: readonly ProviderId[], force = false, signal?: AbortSignal): Promise<UsageDashboardSnapshot> {
    const ids = [...new Set(providerIds)]
    const effectiveSignal = signal ?? new AbortController().signal
    const providers = await Promise.all(ids.map((id) => this.getProvider(id, force, effectiveSignal)))
    return { providers, generatedAt: this.now().toISOString() }
  }

  clear(): void {
    this.generation += 1
    this.entries.clear()
    this.inFlight.clear()
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
      if (generation === this.generation) this.entries.set(id, { snapshot: withExpiry, fetchedAtMs, expiresAtMs })
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
      if (previous !== undefined && (previous.snapshot.state === 'fresh' || previous.snapshot.state === 'stale')) {
        const stale: ProviderSnapshot = {
          ...previous.snapshot,
          state: 'stale',
          warning: diagnostic.message,
          errorCode: diagnostic.code,
          attemptedAt: new Date(startedAt).toISOString(),
        }
        // Other devices must see the failed attempt too, without extending the good data's TTL.
        if (generation === this.generation) this.entries.set(id, { ...previous, snapshot: stale })
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
