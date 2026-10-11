import { normalizeSettings, SETTINGS_SCHEMA } from '../core/settings.js'
import type { UsageDashboardSettings } from '../core/types.js'
import { CREDENTIAL_REFERENCES } from '../core/credentials.js'
import type { CredentialStatus } from '../core/credentials.js'
import { messages } from './messages.js'
import type { UiLocale, UiText } from './messages.js'
import { normalizeLocale } from './i18n.js'

export type SettingsLocale = UiLocale
export const normalizeSettingsLocale = normalizeLocale
const settingsFor = (text: UiText) => ({
  title: text.title, ttl: text.settingsTtl, order: text.settingsOrder,
  caption: text.settingsCaption, ref: text.settingsRef, kind: text.settingsKind,
  status: text.settingsStatus, configured: text.configured, notConfigured: text.notConfigured,
  hint: text.settingsHint, move: text.move, apiKey: text.apiKey, session: text.session, cookie: text.cookie,
})
const SETTINGS_TEXT = {
  en: settingsFor(messages.en), 'zh-Hans': settingsFor(messages['zh-Hans']),
  'zh-Hant': settingsFor(messages['zh-Hant']), ja: settingsFor(messages.ja),
}
export interface SettingsViewModel {
  readonly schema: typeof SETTINGS_SCHEMA
  readonly settings: UsageDashboardSettings
  readonly providerOrder: readonly string[]
  readonly credentials: readonly CredentialStatus[]
}

export function createSettingsViewModel(value: unknown): SettingsViewModel {
  const envelope = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as { settings?: unknown; credentials?: unknown } : undefined
  const settings = normalizeSettings(envelope?.settings ?? value)
  const fallback: CredentialStatus[] = Object.values(CREDENTIAL_REFERENCES).flatMap((references) => references.map((reference) => ({ ...reference, configured: false, writable: false })))
  const rawCredentials = envelope?.credentials
  const credentials = Array.isArray(rawCredentials) ? rawCredentials as CredentialStatus[] : fallback
  return { schema: SETTINGS_SCHEMA, settings, providerOrder: settings.enabledProviders, credentials }
}

function escapeHtml(value: string): string {
  const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return value.replace(/[&<>"']/g, (char) => escaped[char] ?? char)
}

const CREDENTIAL_KIND_KEYS: Record<string, 'apiKey' | 'session' | 'cookie'> = {
  'api-key': 'apiKey', apikey: 'apiKey', session: 'session', cookie: 'cookie',
}

function localizeKind(kind: string, text: { apiKey: string; session: string; cookie: string }): string {
  const name = kind.toLowerCase()
  const key = Object.prototype.hasOwnProperty.call(CREDENTIAL_KIND_KEYS, name) ? CREDENTIAL_KIND_KEYS[name] : undefined
  return key ? text[key] : kind
}

export function renderSettingsHtml(value: unknown, locale: SettingsLocale | unknown = 'en'): string {
  const normalized = typeof locale === 'string' ? normalizeSettingsLocale(locale) : 'en'
  const text = SETTINGS_TEXT[normalized]
  const model = createSettingsViewModel(value)
  const options = model.providerOrder.map((id, index) => `<li draggable="true" data-provider="${id}" data-order="${index}"><button type="button" aria-label="${escapeHtml(text.move.replace('{provider}', id))}">↕</button><span>${id}</span></li>`).join('')
  const credentials = model.credentials.map((item) => `<tr data-credential-ref="${escapeHtml(item.reference)}"><th scope="row">${escapeHtml(item.label)}<br><code>${escapeHtml(item.reference)}</code></th><td>${escapeHtml(localizeKind(item.kind, text))}</td><td>${item.configured ? escapeHtml(text.configured) : escapeHtml(text.notConfigured)}</td></tr>`).join('')
  return `<section class="dsw-settings" data-dsh-usage-settings lang="${normalized}"><h2>${escapeHtml(text.title)}</h2><label>${escapeHtml(text.ttl)}<input type="number" min="5" max="1440" value="${model.settings.refreshTtlMinutes}" name="refreshTtlMinutes"></label><ol aria-label="${escapeHtml(text.order)}">${options}</ol><table><caption>${escapeHtml(text.caption)}</caption><thead><tr><th>${escapeHtml(text.ref)}</th><th>${escapeHtml(text.kind)}</th><th>${escapeHtml(text.status)}</th></tr></thead><tbody>${credentials}</tbody></table><p class="dsw-settings__hint">${escapeHtml(text.hint)}</p></section>`
}

export const settingsText = SETTINGS_TEXT
