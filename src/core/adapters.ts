import { hasSecret, CREDENTIAL_REFERENCES } from './credentials.js'
import { UsageDashboardError } from './errors.js'
import { requestJson } from './http.js'
import type { EndpointPolicy } from './http.js'
import type {
  CodexRateLimitWindow,
  CodexRateLimitsPayload,
  CodexUsageSource,
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderId,
  ProviderSnapshot,
  UsageMetric,
} from './types.js'

const OPENROUTER_POLICY: EndpointPolicy = { providerId: 'openrouter', hostname: 'openrouter.ai', pathname: '/api/v1/credits' }
const DEEPSEEK_POLICY: EndpointPolicy = { providerId: 'deepseek', hostname: 'api.deepseek.com', pathname: '/user/balance' }
const TAVILY_POLICY: EndpointPolicy = { providerId: 'tavily', hostname: 'api.tavily.com', pathname: '/usage' }
const OPENCODE_GO_POLICY: EndpointPolicy = { providerId: 'opencode-go', hostname: 'opencode.ai', pathname: '/zen/go/v1/usage' }

function credentialMissing(providerId: ProviderId, reference: string): never {
  throw new UsageDashboardError('credential-missing', `Configure the ${reference} credential first.`, { providerId })
}

function firstCredential(adapter: ProviderAdapter): string {
  const reference = adapter.credentialReferences[0]
  if (reference === undefined) throw new UsageDashboardError('credential-missing', 'This provider has no configured credential reference.', { providerId: adapter.id })
  return reference
}

function numberField(value: unknown, field: string, providerId: ProviderId): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UsageDashboardError('provider-invalid-response', `The ${providerId} response is missing ${field}.`, { providerId })
  }
  return value
}

function snapshot(
  providerId: ProviderId,
  displayName: string,
  stability: 'stable' | 'experimental',
  context: ProviderAdapterContext,
  metrics: readonly UsageMetric[],
): ProviderSnapshot {
  const fetchedAt = context.now().toISOString()
  return { providerId, displayName, stability, state: 'fresh', fetchedAt, metrics }
}

function configuredSnapshot(providerId: ProviderId, displayName: string, stability: 'stable' | 'experimental'): ProviderSnapshot {
  return { providerId, displayName, stability, state: 'needs-configuration', metrics: [] }
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = 'openrouter' as const
  readonly displayName = 'OpenRouter'
  readonly stability = 'stable' as const
  readonly credentialReferences = CREDENTIAL_REFERENCES.openrouter.map((item) => item.reference)

  async refresh(context: ProviderAdapterContext, signal: AbortSignal): Promise<ProviderSnapshot> {
    const reference = firstCredential(this)
    const token = await context.credentials.resolve(reference, signal)
    if (!hasSecret(token)) credentialMissing(this.id, reference)
    const body = await requestJson<unknown>(context.fetch, {
      url: 'https://openrouter.ai/api/v1/credits',
      headers: { Authorization: `Bearer ${token}` },
    }, OPENROUTER_POLICY, signal, undefined, context.logger)
    if (!isRecord(body) || !isRecord(body.data)) {
      throw new UsageDashboardError('provider-invalid-response', 'OpenRouter returned an invalid credits response.', { providerId: this.id })
    }
    const totalCredits = numberField(body.data.total_credits, 'total_credits', this.id)
    const totalUsage = numberField(body.data.total_usage, 'total_usage', this.id)
    return snapshot(this.id, this.displayName, this.stability, context, [{
      kind: 'balance', currency: 'USD', purchased: totalCredits, used: totalUsage,
      remaining: Math.max(0, totalCredits - totalUsage),
    }])
  }
}

export class DeepseekAdapter implements ProviderAdapter {
  readonly id = 'deepseek' as const
  readonly displayName = 'DeepSeek'
  readonly stability = 'stable' as const
  readonly credentialReferences = CREDENTIAL_REFERENCES.deepseek.map((item) => item.reference)

  async refresh(context: ProviderAdapterContext, signal: AbortSignal): Promise<ProviderSnapshot> {
    const reference = firstCredential(this)
    const token = await context.credentials.resolve(reference, signal)
    if (!hasSecret(token)) credentialMissing(this.id, reference)
    const body = await requestJson<unknown>(context.fetch, {
      url: 'https://api.deepseek.com/user/balance',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, DEEPSEEK_POLICY, signal, undefined, context.logger)
    if (!isRecord(body) || !Array.isArray(body.balance_infos)) {
      throw new UsageDashboardError('provider-invalid-response', 'DeepSeek returned an invalid balance response.', { providerId: this.id })
    }
    const metrics: UsageMetric[] = []
    for (const entry of body.balance_infos) {
      if (!isRecord(entry)) continue
      const currency = typeof entry.currency === 'string' && entry.currency.length > 0 ? entry.currency : 'CNY'
      const total = parseBalanceAmount(entry.total_balance)
      if (total === undefined) {
        throw new UsageDashboardError('provider-invalid-response', 'DeepSeek returned an invalid balance amount.', { providerId: this.id })
      }
      metrics.push({ kind: 'balance', currency, remaining: total, label: `Balance (${currency})` })
    }
    if (metrics.length === 0) {
      throw new UsageDashboardError('provider-invalid-response', 'DeepSeek returned no balance entries.', { providerId: this.id })
    }
    const warning = body.is_available === false ? 'DeepSeek reports the balance is insufficient for API calls.' : undefined
    const base = snapshot(this.id, this.displayName, this.stability, context, metrics)
    return warning === undefined ? base : { ...base, warning }
  }
}

function parseBalanceAmount(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return typeof num === 'number' && Number.isFinite(num) && num >= 0 ? num : undefined
}

export class DeepgramAdapter implements ProviderAdapter {
  readonly id = 'deepgram' as const
  readonly displayName = 'Deepgram'
  readonly stability = 'stable' as const
  readonly credentialReferences = CREDENTIAL_REFERENCES.deepgram.map((item) => item.reference)

  async refresh(context: ProviderAdapterContext, signal: AbortSignal): Promise<ProviderSnapshot> {
    const reference = firstCredential(this)
    const token = await context.credentials.resolve(reference, signal)
    if (!hasSecret(token)) credentialMissing(this.id, reference)
    const options = context.settings.providerOptions.deepgram
    if (options?.projectId === undefined || options.balanceId === undefined) {
      // Key is present but the balance endpoint cannot be called without both
      // identifiers. Return needs-configuration WITH an explicit warning so the
      // UI does not mislead the user into thinking the API key itself is missing.
      return {
        ...configuredSnapshot(this.id, this.displayName, this.stability),
        warning: 'Deepgram needs providerOptions.deepgram.projectId and balanceId before the balance can be fetched. The API key alone is not enough.',
      }
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.projectId) || !/^[A-Za-z0-9_-]{1,128}$/.test(options.balanceId)) {
      throw new UsageDashboardError('bad-request', 'Deepgram project and balance identifiers are invalid.', { providerId: this.id })
    }
    const url = `https://api.deepgram.com/v1/projects/${options.projectId}/balances/${options.balanceId}`
    const policy: EndpointPolicy = { providerId: this.id, hostname: 'api.deepgram.com', pathname: { prefix: '/v1/projects/' } }
    const body = await requestJson<unknown>(context.fetch, { url, headers: { Authorization: `Token ${token}` } }, policy, signal, undefined, context.logger)
    if (!isRecord(body)) throw new UsageDashboardError('provider-invalid-response', 'Deepgram returned an invalid balance response.', { providerId: this.id })
    const amount = numberField(body.amount, 'amount', this.id)
    const units = typeof body.units === 'string' && body.units.length > 0 ? body.units : 'USD'
    return snapshot(this.id, this.displayName, this.stability, context, [{ kind: 'balance', currency: units, remaining: amount }])
  }
}

export class TavilyAdapter implements ProviderAdapter {
  readonly id = 'tavily' as const
  readonly displayName = 'Tavily'
  readonly stability = 'stable' as const
  readonly credentialReferences = CREDENTIAL_REFERENCES.tavily.map((item) => item.reference)

  async refresh(context: ProviderAdapterContext, signal: AbortSignal): Promise<ProviderSnapshot> {
    const reference = firstCredential(this)
    const token = await context.credentials.resolve(reference, signal)
    if (!hasSecret(token)) credentialMissing(this.id, reference)
    const projectId = context.settings.providerOptions.tavily?.projectId
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (projectId !== undefined) headers['X-Project-ID'] = projectId
    const body = await requestJson<unknown>(context.fetch, { url: 'https://api.tavily.com/usage', headers }, TAVILY_POLICY, signal, undefined, context.logger)
    if (!isRecord(body)) throw new UsageDashboardError('provider-invalid-response', 'Tavily returned an invalid usage response.', { providerId: this.id })
    const metrics: UsageMetric[] = []
    if (isRecord(body.key)) addQuota(metrics, body.key, 'key')
    if (isRecord(body.account)) addQuota(metrics, body.account, 'account')
    if (metrics.length === 0) throw new UsageDashboardError('provider-invalid-response', 'Tavily returned no usage metrics.', { providerId: this.id })
    return snapshot(this.id, this.displayName, this.stability, context, metrics)
  }
}

const OPENCODE_GO_WINDOWS = [
  { key: 'rolling', label: 'Rolling (5h)', kind: 'rolling' as const },
  { key: 'weekly', label: 'Weekly', kind: 'calendar' as const },
  { key: 'monthly', label: 'Monthly', kind: 'calendar' as const },
] as const

function opencodeGoWindow(value: unknown, label: string, kind: 'rolling' | 'calendar', providerId: ProviderId): UsageMetric {
  if (!isRecord(value) || value.status !== 'ok' || typeof value.percent !== 'number' || !Number.isFinite(value.percent) || value.percent < 0 || value.percent > 100 || typeof value.resetsAt !== 'string' || !Number.isFinite(Date.parse(value.resetsAt))) {
    throw new UsageDashboardError('provider-invalid-response', `OpenCode Go returned an invalid ${label} usage window.`, { providerId })
  }
  return {
    kind: 'quota',
    unit: 'percent',
    used: value.percent,
    limit: 100,
    label,
    window: { kind, label, resetsAt: value.resetsAt },
  }
}

export class OpenCodeGoAdapter implements ProviderAdapter {
  readonly id = 'opencode-go' as const
  readonly displayName = 'OpenCode Go'
  readonly stability = 'experimental' as const
  readonly credentialReferences = CREDENTIAL_REFERENCES['opencode-go'].map((item) => item.reference)

  async refresh(context: ProviderAdapterContext, signal: AbortSignal): Promise<ProviderSnapshot> {
    const reference = firstCredential(this)
    const token = await context.credentials.resolve(reference, signal)
    if (!hasSecret(token)) credentialMissing(this.id, reference)
    const body = await requestJson<unknown>(context.fetch, {
      url: 'https://opencode.ai/zen/go/v1/usage',
      headers: { Authorization: `Bearer ${token}` },
    }, OPENCODE_GO_POLICY, signal, undefined, context.logger)
    if (!isRecord(body) || !isRecord(body.usage)) {
      throw new UsageDashboardError('provider-invalid-response', 'OpenCode Go returned an invalid usage response.', { providerId: this.id })
    }
    const metrics: UsageMetric[] = []
    for (const window of OPENCODE_GO_WINDOWS) {
      if (!Object.prototype.hasOwnProperty.call(body.usage, window.key)) continue
      metrics.push(opencodeGoWindow(body.usage[window.key], window.label, window.kind, this.id))
    }
    if (metrics.length === 0) {
      throw new UsageDashboardError('provider-invalid-response', 'OpenCode Go returned no usage windows.', { providerId: this.id })
    }
    return snapshot(this.id, this.displayName, this.stability, context, metrics)
  }
}

function addQuota(metrics: UsageMetric[], value: Record<string, unknown>, prefix: string): void {
  const candidates = prefix === 'key'
    ? [{ used: value.usage, limit: value.limit, label: 'API key' }]
    : [
        { used: value.plan_usage, limit: value.plan_limit, label: 'Plan' },
        { used: value.paygo_usage, limit: value.paygo_limit, label: 'Pay as you go' },
      ]
  for (const candidate of candidates) {
    if (typeof candidate.used === 'number' && typeof candidate.limit === 'number' && Number.isFinite(candidate.used) && Number.isFinite(candidate.limit)) {
      metrics.push({ kind: 'quota', unit: 'credits', used: candidate.used, limit: candidate.limit, label: candidate.label })
    }
  }
}

export function normalizeCodexRateLimits(payload: CodexRateLimitsPayload, now = new Date()): UsageMetric[] {
  const metrics: UsageMetric[] = []
  const modern = payload.rateLimits
  if (modern !== undefined) {
    addWindow(metrics, modern.primary, 'Primary')
    addWindow(metrics, modern.secondary, 'Secondary')
    for (const entry of modern.additional ?? []) {
      const label = entry.limitName ?? entry.meteredFeature ?? 'Additional'
      addWindow(metrics, entry.rateLimit?.primaryWindow, label)
      addWindow(metrics, entry.rateLimit?.secondaryWindow, `${label} secondary`)
    }
  }
  const legacy = payload.rate_limit
  if (metrics.length === 0 && legacy !== undefined) {
    addWindow(metrics, legacy.primary_window, 'Primary')
    addWindow(metrics, legacy.secondary_window, 'Secondary')
  }
  if (metrics.length === 0 && payload.additional_rate_limits !== undefined) {
    for (const entry of payload.additional_rate_limits) {
      const label = entry.limit_name ?? entry.metered_feature ?? 'Additional'
      addWindow(metrics, entry.rate_limit?.primary_window, label)
      addWindow(metrics, entry.rate_limit?.secondary_window, `${label} secondary`)
    }
  }
  return metrics.map((metric) => {
    if (metric.kind !== 'quota' || metric.window?.resetsAt === undefined) return metric
    const timestamp = Date.parse(metric.window.resetsAt)
    return Number.isFinite(timestamp) && timestamp < now.getTime() ? { ...metric, window: { ...metric.window, resetsAt: now.toISOString() } } : metric
  })
}

function addWindow(metrics: UsageMetric[], value: CodexRateLimitWindow | null | undefined, label: string): void {
  if (value === undefined || value === null || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return
  const used = Math.min(100, Math.max(0, value.usedPercent))
  const reset = typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) ? new Date(value.resetsAt * 1000).toISOString() : undefined
  const usageWindow = {
    kind: 'rolling' as const,
    ...(value.windowDurationMins === undefined ? {} : { durationSeconds: Math.max(0, value.windowDurationMins * 60) }),
    ...(reset === undefined ? {} : { resetsAt: reset }),
  }
  metrics.push({ kind: 'quota', unit: 'percent', used, limit: 100, label, window: usageWindow })
}

export class ChatGptCodexAdapter implements ProviderAdapter {
  readonly id = 'chatgpt-codex' as const
  readonly displayName = 'ChatGPT / Codex'
  readonly stability = 'stable' as const
  readonly credentialReferences = [] as const
  private readonly source?: CodexUsageSource

  constructor(source?: CodexUsageSource) {
    this.source = source
  }

  async refresh(context: ProviderAdapterContext, signal: AbortSignal): Promise<ProviderSnapshot> {
    if (this.source === undefined) return configuredSnapshot(this.id, this.displayName, this.stability)
    const payload = await this.source.read(signal)
    const metrics = normalizeCodexRateLimits(payload, context.now())
    if (metrics.length === 0) throw new UsageDashboardError('provider-invalid-response', 'Codex returned no rate-limit windows.', { providerId: this.id })
    return snapshot(this.id, this.displayName, this.stability, context, metrics)
  }
}

export class UnsupportedAdapter implements ProviderAdapter {
  readonly stability = 'experimental' as const
  readonly credentialReferences: readonly string[]

  constructor(readonly id: Exclude<ProviderId, 'openrouter' | 'deepseek' | 'deepgram' | 'tavily' | 'chatgpt-codex' | 'opencode-go'>, readonly displayName: string, credentialReferences: readonly string[] = []) {
    this.credentialReferences = credentialReferences
  }

  async refresh(): Promise<ProviderSnapshot> {
    return { providerId: this.id, displayName: this.displayName, stability: this.stability, state: 'unsupported', metrics: [], warning: 'No zero-cost read-only usage endpoint is verified for this provider.' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createDefaultAdapters(codexSource?: CodexUsageSource): readonly ProviderAdapter[] {
  return [
    new OpenRouterAdapter(),
    new DeepseekAdapter(),
    new UnsupportedAdapter('kilo', 'Kilo', CREDENTIAL_REFERENCES.kilo.map((item) => item.reference)),
    new DeepgramAdapter(),
    new UnsupportedAdapter('serper', 'Serper.dev', CREDENTIAL_REFERENCES.serper.map((item) => item.reference)),
    new ChatGptCodexAdapter(codexSource),
    new OpenCodeGoAdapter(),
    new TavilyAdapter(),
    new UnsupportedAdapter('brave-search', 'Brave Search', CREDENTIAL_REFERENCES['brave-search'].map((item) => item.reference)),
  ]
}
