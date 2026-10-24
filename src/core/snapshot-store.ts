import { PROVIDER_IDS } from './types.js'
import type { ProviderSnapshot, PublicUsageError, UsageMetric } from './types.js'

/** The host owns the profile-local persistence mechanism. Never stores credentials. */
export interface UsageSnapshotStore {
  read(): Promise<unknown>
  write(value: StoredUsageSnapshots): Promise<void>
}

export interface StoredUsageSnapshots {
  readonly version: 1
  readonly scope: string
  readonly providers: readonly ProviderSnapshot[]
}

export const MAX_STORED_SNAPSHOT_BYTES = 64 * 1024
const ERROR_CODES = ['bad-request', 'endpoint-not-allowed', 'credential-missing', 'credential-rejected', 'credential-not-writable', 'provider-http', 'provider-timeout', 'provider-invalid-response', 'provider-unsupported', 'internal']
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value))
const label = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 120 ? value : undefined
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function metric(value: unknown): UsageMetric | undefined {
  if (!record(value)) return undefined
  const caption = label(value.label)
  if (value.kind === 'balance' && finite(value.remaining) && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency)) {
    return { kind: 'balance', remaining: value.remaining, currency: value.currency,
      ...(caption === undefined ? {} : { label: caption }),
      ...(finite(value.used) ? { used: value.used } : {}),
      ...(finite(value.purchased) ? { purchased: value.purchased } : {}) }
  }
  if (value.kind !== 'quota' || !['requests', 'credits', 'usd', 'percent'].includes(String(value.unit)) || !finite(value.used) || !finite(value.limit)) return undefined
  const window = value.window
  return { kind: 'quota', unit: value.unit as 'requests' | 'credits' | 'usd' | 'percent', used: value.used, limit: value.limit,
    ...(caption === undefined ? {} : { label: caption }),
    ...(record(window) && (window.kind === 'rolling' || window.kind === 'calendar') ? { window: { kind: window.kind,
      ...(label(window.label) === undefined ? {} : { label: label(window.label) }),
      ...(timestamp(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
      ...(finite(window.durationSeconds) && window.durationSeconds > 0 ? { durationSeconds: window.durationSeconds } : {}) } } : {}) }
}

/** Strict display-field projection; unknown fields and raw warnings never reach disk. */
export function normalizeStoredProvider(value: unknown): ProviderSnapshot | undefined {
  if (!record(value) || !(PROVIDER_IDS as readonly unknown[]).includes(value.providerId) || !['fresh', 'stale'].includes(String(value.state)) || !timestamp(value.fetchedAt) || !timestamp(value.expiresAt) || !Array.isArray(value.metrics) || value.metrics.length > 32) return undefined
  const metrics = value.metrics.map(metric)
  if (metrics.some(item => item === undefined)) return undefined
  return { providerId: value.providerId as ProviderSnapshot['providerId'], displayName: label(value.displayName) ?? String(value.providerId),
    stability: value.stability === 'stable' ? 'stable' : 'experimental', state: value.state as 'fresh' | 'stale',
    fetchedAt: value.fetchedAt, expiresAt: value.expiresAt, metrics: metrics as UsageMetric[],
    ...(timestamp(value.attemptedAt) ? { attemptedAt: value.attemptedAt } : {}),
    ...(typeof value.errorCode === 'string' && ERROR_CODES.includes(value.errorCode) ? { errorCode: value.errorCode as PublicUsageError['code'] } : {}) }
}

export function withinSnapshotLimit(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_STORED_SNAPSHOT_BYTES } catch { return false }
}

export function readStoredProviders(value: unknown, scope: string): readonly ProviderSnapshot[] {
  if (!record(value) || value.version !== 1 || value.scope !== scope || !Array.isArray(value.providers) || value.providers.length > PROVIDER_IDS.length || !withinSnapshotLimit(value)) return []
  const providers = value.providers.map(normalizeStoredProvider)
  if (providers.some(provider => provider === undefined) || new Set(providers.map(provider => provider?.providerId)).size !== providers.length) return []
  return providers as ProviderSnapshot[]
}
