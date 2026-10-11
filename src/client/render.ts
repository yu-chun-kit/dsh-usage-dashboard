import type { ProviderId, ProviderSnapshot } from '../core/types.js'
import type { DashboardClientState } from './controller.js'
import { CREDENTIAL_REFERENCES } from '../core/credentials.js'
import { messages } from './messages.js'
import type { UiLocale, UiText } from './messages.js'
import { normalizeLocale, metricLabel, metricValue, providerWarning, friendlyError } from './i18n.js'

export type DashboardLocale = UiLocale
export const normalizeDashboardLocale = normalizeLocale
const labelsFor = (text: UiText) => ({ ...text, title: text.panelTitle, refresh: text.refreshUsage, needsConfiguration: text.needsConfig, needsCredential: text.needsCred })
export const dashboardText = {
  en: labelsFor(messages.en), 'zh-Hans': labelsFor(messages['zh-Hans']),
  'zh-Hant': labelsFor(messages['zh-Hant']), ja: labelsFor(messages.ja),
}

function escapeHtml(value: string): string {
  const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return value.replace(/[&<>"']/g, char => escaped[char] ?? char)
}

function credentialHint(providerId: ProviderId): string {
  return (CREDENTIAL_REFERENCES[providerId] ?? []).map(item => item.reference).join(' / ')
}

function providerCard(provider: ProviderSnapshot, locale: UiLocale): string {
  const labels = messages[locale]
  const statuses = { fresh: labels.fresh, stale: labels.stale, error: labels.error, unsupported: labels.unsupported, 'needs-configuration': labels.needsConfig }
  const tags = `<span class="dsw-status${provider.state === 'stale' ? ' dsw-status--stale' : ''}">${escapeHtml(statuses[provider.state] ?? labels.unknown)}</span>`
  const metrics = provider.metrics.length === 0 ? '<p class="dsw-card__empty">—</p>' : provider.metrics.map(metric => `<div class="dsw-metric"><span>${escapeHtml(metricLabel(metric, labels))}</span><strong>${escapeHtml(metricValue(metric, locale, labels))}</strong></div>`).join('')
  const hint = providerWarning(provider, labels)
  const warning = hint === undefined ? '' : `<p class="dsw-card__warning">${escapeHtml(hint)}</p>`
  const refs = credentialHint(provider.providerId)
  const cred = provider.metrics.length === 0 && refs.length > 0 && (provider.state === 'needs-configuration' || provider.state === 'error')
    ? `<p class="dsw-card__cred">${escapeHtml(labels.needsCred)}: <code>${escapeHtml(refs)}</code></p>` : ''
  return `<article class="dsw-card" data-provider="${escapeHtml(provider.providerId)}" aria-label="${escapeHtml(provider.displayName)}"><header class="dsw-card__header"><h3>${escapeHtml(provider.displayName)}</h3><div>${tags}</div></header>${metrics}${cred}${warning}</article>`
}

export function renderDashboardHtml(state: DashboardClientState, locale: unknown = 'en'): string {
  const normalized = normalizeLocale(locale)
  const labels = dashboardText[normalized]
  const expanded = state.expanded
  const providers = state.snapshot?.providers ?? []
  const cards = providers.length === 0 ? `<p class="dsw-empty">${escapeHtml(state.loading ? labels.loading : labels.empty)}</p>` : providers.map(provider => providerCard(provider, normalized)).join('')
  const error = state.error === undefined ? '' : `<p class="dsw-error" role="alert">${escapeHtml(friendlyError({ code: state.errorCode }, labels, labels.usageError))}</p>`
  return `<section class="dsw-dashboard" data-dsh-usage-dashboard lang="${normalized}" data-expanded="${expanded ? 'true' : 'false'}"><div class="dsw-dashboard__bar"><button type="button" class="dsw-dashboard__toggle" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="dsw-usage-panel">${escapeHtml(expanded ? labels.collapse : labels.expand)}</button><span class="dsw-dashboard__title">${escapeHtml(labels.title)}</span>${expanded ? `<button type="button" class="dsw-dashboard__refresh" aria-label="${escapeHtml(labels.refresh)}">${escapeHtml(labels.refresh)}</button>` : ''}</div>${expanded ? `<div id="dsw-usage-panel" class="dsw-dashboard__panel" tabindex="0" role="region" aria-label="${escapeHtml(labels.title)}"><div class="dsw-cards" tabindex="0">${cards}</div>${error}</div>` : ''}</section>`
}
