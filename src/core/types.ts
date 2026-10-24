export const PROVIDER_IDS = [
  'openrouter',
  'deepseek',
  'kilo',
  'deepgram',
  'serper',
  'chatgpt-codex',
  'opencode-go',
  'tavily',
  'brave-search',
] as const

import type { UsageLogger } from './logging.js'
import type { UsageActivity } from './activity.js'

export type ProviderId = (typeof PROVIDER_IDS)[number]
export type ProviderStability = 'stable' | 'experimental'
export type ProviderState =
  | 'fresh'
  | 'stale'
  | 'needs-configuration'
  | 'unsupported'
  | 'error'

export interface UsageWindow {
  readonly kind: 'rolling' | 'calendar'
  readonly label?: string
  readonly durationSeconds?: number
  readonly resetsAt?: string
}

export type UsageMetric =
  | {
      readonly kind: 'balance'
      readonly currency: string
      readonly remaining: number
      readonly purchased?: number
      readonly used?: number
      readonly label?: string
    }
  | {
      readonly kind: 'quota'
      readonly unit: 'requests' | 'credits' | 'usd' | 'percent'
      readonly used: number
      readonly limit: number
      readonly window?: UsageWindow
      readonly label?: string
    }

export interface ProviderSnapshot {
  readonly providerId: ProviderId
  readonly displayName: string
  readonly stability: ProviderStability
  readonly state: ProviderState
  readonly fetchedAt?: string
  readonly expiresAt?: string
  readonly attemptedAt?: string
  readonly errorCode?: PublicUsageError['code']
  readonly metrics: readonly UsageMetric[]
  readonly warning?: string
}

export interface UsageDashboardSnapshot {
  readonly providers: readonly ProviderSnapshot[]
  readonly generatedAt: string
  readonly activity?: UsageActivity
  /** Present for cache-only reads. True means data is missing or expired. */
  readonly needsRefresh?: boolean
}

export interface UsageDashboardSettings {
  readonly enabledProviders: readonly ProviderId[]
  readonly refreshTtlMinutes: number
  readonly providerOptions: Readonly<{
    readonly deepgram?: Readonly<{ readonly projectId?: string; readonly balanceId?: string }>
    readonly kilo?: Readonly<{ readonly organizationId?: string }>
    readonly tavily?: Readonly<{ readonly projectId?: string }>
    readonly chatgptCodex?: Readonly<{ readonly codexCommand?: string }>
  }>
}

export interface CredentialResolver {
  resolve(reference: string, signal?: AbortSignal): Promise<string | undefined>
}

export interface ProviderRequest {
  readonly url: string
  readonly method?: 'GET'
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

export interface ProviderResponse {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  text(): Promise<string>
}

export type ProviderFetch = (request: ProviderRequest) => Promise<ProviderResponse>

export interface ProviderAdapterContext {
  readonly credentials: CredentialResolver
  readonly fetch: ProviderFetch
  readonly settings: UsageDashboardSettings
  readonly now: () => Date
  readonly logger?: UsageLogger
}

export interface ProviderAdapter {
  readonly id: ProviderId
  readonly displayName: string
  readonly stability: ProviderStability
  readonly credentialReferences: readonly string[]
  refresh(context: ProviderAdapterContext, signal: AbortSignal): Promise<ProviderSnapshot>
}

export interface CodexRateLimitWindow {
  readonly usedPercent?: number
  readonly windowDurationMins?: number
  readonly resetsAt?: number
}

export interface CodexRateLimitsPayload {
  readonly rateLimits?: Readonly<{
    readonly primary?: CodexRateLimitWindow | null
    readonly secondary?: CodexRateLimitWindow | null
    readonly additional?: ReadonlyArray<Readonly<{
      readonly limitName?: string
      readonly meteredFeature?: string
      readonly rateLimit?: Readonly<{
        readonly primaryWindow?: CodexRateLimitWindow | null
        readonly secondaryWindow?: CodexRateLimitWindow | null
      }>
    }>>
  }>
  readonly rate_limit?: Readonly<{
    readonly primary_window?: CodexRateLimitWindow | null
    readonly secondary_window?: CodexRateLimitWindow | null
  }>
  readonly additional_rate_limits?: ReadonlyArray<Readonly<{
    readonly limit_name?: string
    readonly metered_feature?: string
    readonly rate_limit?: Readonly<{
      readonly primary_window?: CodexRateLimitWindow | null
      readonly secondary_window?: CodexRateLimitWindow | null
    }>
  }>>
}

export interface CodexUsageSource {
  read(signal: AbortSignal): Promise<CodexRateLimitsPayload>
}

export interface PublicUsageError {
  readonly code:
    | 'bad-request'
    | 'endpoint-not-allowed'
    | 'credential-missing'
    | 'credential-rejected'
    | 'credential-not-writable'
    | 'provider-http'
    | 'provider-timeout'
    | 'provider-invalid-response'
    | 'provider-unsupported'
    | 'internal'
  readonly message: string
  readonly providerId?: ProviderId
  readonly status?: number
}
