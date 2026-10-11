import type { ProviderSnapshot, UsageMetric } from '../core/types.js'
import type { UiLocale, UiText } from './messages.js'

export function supportedLocale(value: unknown): UiLocale | undefined {
  if (typeof value !== 'string') return undefined
  const tag = value.trim().replace(/_/g, '-').toLowerCase()
  if (tag === 'en' || tag.startsWith('en-')) return 'en'
  if (tag === 'ja' || tag.startsWith('ja-')) return 'ja'
  if (tag === 'zh-hans' || tag.startsWith('zh-hans-')) return 'zh-Hans'
  if (tag === 'zh-hant' || tag.startsWith('zh-hant-')) return 'zh-Hant'
  const region = tag.split('-')[1]
  if (tag === 'zh' || (tag.startsWith('zh-') && ['cn', 'sg', 'my'].includes(region ?? ''))) return 'zh-Hans'
  if (tag.startsWith('zh-') && ['tw', 'hk', 'mo'].includes(region ?? '')) return 'zh-Hant'
  return undefined
}

export function normalizeLocale(value: unknown): UiLocale {
  return supportedLocale(value) ?? 'en'
}

export function metricLabel(metric: UsageMetric, labels: UiText): string {
  const value = metric.label ?? (metric.kind === 'quota' ? metric.window?.label : undefined)
  if (!value) return metric.kind === 'balance' ? labels.balance : labels.quota
  const names: Record<string, string> = {
    Balance: labels.balance, Quota: labels.quota, 'Rolling (5h)': labels.rolling5h,
    Weekly: labels.weekly, Monthly: labels.monthly, 'API key': labels.apiKey,
    Plan: labels.plan, 'Pay as you go': labels.paygo,
    Primary: labels.primary, Secondary: labels.secondary, Additional: labels.additional,
  }
  if (Object.prototype.hasOwnProperty.call(names, value)) return names[value]!
  const balance = /^Balance \(([A-Z]{3})\)$/.exec(value)
  if (balance) return `${labels.balance} (${balance[1]})`
  if (value.endsWith(' secondary')) {
    const base = value.slice(0, -10)
    return labels.secondarySuffix.replace('{label}', Object.prototype.hasOwnProperty.call(names, base) ? names[base]! : base)
  }
  return value
}

export function metricValue(metric: UsageMetric, locale: UiLocale, labels: UiText): string {
  const number = (value: number) => value.toLocaleString(locale)
  if (metric.kind === 'balance') return `${number(metric.remaining)} ${metric.currency}`
  const unit = metric.unit === 'usd' ? 'USD' : labels[metric.unit]
  return `${number(metric.used)} / ${number(metric.limit)} ${unit}`
}

export function friendlyError(error: unknown, labels: UiText, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback
  const item = error as { code?: string; transport?: boolean; key?: string }
  const keys: Record<string, keyof UiText> = {
    'session-required': 'sessionHint', 'untrusted-host': 'forbiddenHint',
    'credential-missing': 'missingHint', 'credential-rejected': 'rejectedHint',
    'credential-not-writable': 'notWritableHint', 'provider-http': 'providerHttpHint',
    'provider-timeout': 'timeoutHint', 'provider-invalid-response': 'invalidResponseHint',
    'provider-unsupported': 'unsupportedHint', 'bad-request': 'badRequestHint',
    'endpoint-not-allowed': 'endpointHint', internal: 'internalHint',
  }
  // Form messages stay as message keys so live language changes also translate them.
  const formKeys = ['saving', 'saved', 'readOnly', 'unknown', 'need8']
  if (item.key && formKeys.includes(item.key)) return labels[item.key as keyof UiText]
  if (item.code && Object.prototype.hasOwnProperty.call(keys, item.code)) return labels[keys[item.code]!]
  return item.transport ? labels.transportHint : fallback
}

export function providerWarning(provider: ProviderSnapshot, labels: UiText): string | undefined {
  if (provider.state === 'stale') return labels.staleHint
  if (provider.errorCode) return friendlyError({ code: provider.errorCode }, labels, labels.usageError)
  if (provider.providerId === 'deepgram' && provider.state === 'needs-configuration' && provider.warning?.includes('providerOptions')) return labels.needsDeepgramOptions
  if (provider.providerId === 'chatgpt-codex' && provider.state === 'needs-configuration') return labels.localSession
  if (provider.state === 'unsupported') return labels.unsupportedHint
  if (provider.providerId === 'deepseek' && provider.warning === 'DeepSeek reports the balance is insufficient for API calls.') return labels.insufficientHint
  return provider.warning
}
