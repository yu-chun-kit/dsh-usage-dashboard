import { describeKnownReference } from './credentials.js'

export interface ManualRefreshActivity {
  readonly requestedAt: string
  readonly completedAt?: string
  readonly outcome?: 'complete' | 'partial' | 'failed'
}

/** Shared, non-secret metadata. Never contains a credential or provider response. */
export interface UsageActivity {
  readonly credentialUpdatedAt?: Readonly<Record<string, string>>
  readonly lastManualRefresh?: ManualRefreshActivity
}

export interface UsageActivityStore {
  read(): Promise<UsageActivity>
  update(change: (current: UsageActivity) => UsageActivity): Promise<UsageActivity>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value))
}

export function normalizeActivity(value: unknown): UsageActivity {
  if (!record(value)) return {}
  const credentialUpdatedAt: Record<string, string> = {}
  if (record(value.credentialUpdatedAt)) {
    for (const [reference, at] of Object.entries(value.credentialUpdatedAt)) {
      if (describeKnownReference(reference) !== undefined && timestamp(at)) credentialUpdatedAt[reference] = at
    }
  }
  const refresh = value.lastManualRefresh
  const lastManualRefresh: ManualRefreshActivity | undefined = record(refresh) && timestamp(refresh.requestedAt)
    ? {
        requestedAt: refresh.requestedAt,
        ...(timestamp(refresh.completedAt) ? { completedAt: refresh.completedAt } : {}),
        ...(refresh.outcome === 'complete' || refresh.outcome === 'partial' || refresh.outcome === 'failed' ? { outcome: refresh.outcome } : {}),
      }
    : undefined
  return { credentialUpdatedAt, ...(lastManualRefresh === undefined ? {} : { lastManualRefresh }) }
}
