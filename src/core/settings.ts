import { PROVIDER_IDS } from './types.js'
import type { ProviderId, UsageDashboardSettings } from './types.js'

export const DEFAULT_SETTINGS: UsageDashboardSettings = {
  enabledProviders: [],
  refreshTtlMinutes: 15,
  providerOptions: {},
}

const PROVIDER_SET = new Set<string>(PROVIDER_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 || trimmed.length > 256 ? undefined : trimmed
}

function safeOption(value: unknown): Readonly<{ projectId?: string; balanceId?: string; organizationId?: string; codexCommand?: string }> {
  if (!isRecord(value)) return {}
  const result: { projectId?: string; balanceId?: string; organizationId?: string; codexCommand?: string } = {}
  const projectId = safeText(value.projectId)
  const balanceId = safeText(value.balanceId)
  const organizationId = safeText(value.organizationId)
  const codexCommand = safeText(value.codexCommand)
  if (projectId !== undefined) result.projectId = projectId
  if (balanceId !== undefined) result.balanceId = balanceId
  if (organizationId !== undefined) result.organizationId = organizationId
  if (codexCommand !== undefined) result.codexCommand = codexCommand
  return result
}

export function normalizeSettings(value: unknown): UsageDashboardSettings {
  if (!isRecord(value)) return DEFAULT_SETTINGS
  const enabledProviders: ProviderId[] = []
  if (Array.isArray(value.enabledProviders)) {
    for (const candidate of value.enabledProviders) {
      if (typeof candidate === 'string' && PROVIDER_SET.has(candidate) && !enabledProviders.includes(candidate as ProviderId)) {
        enabledProviders.push(candidate as ProviderId)
      }
    }
  }

  const rawTtl = typeof value.refreshTtlMinutes === 'number' && Number.isFinite(value.refreshTtlMinutes)
    ? Math.round(value.refreshTtlMinutes)
    : DEFAULT_SETTINGS.refreshTtlMinutes
  const refreshTtlMinutes = Math.min(1440, Math.max(5, rawTtl))
  const rawOptions = isRecord(value.providerOptions) ? value.providerOptions : {}
  const deepgram = safeOption(rawOptions.deepgram)
  const kilo = safeOption(rawOptions.kilo)
  const tavily = safeOption(rawOptions.tavily)
  const chatgptCodex = safeOption(rawOptions.chatgptCodex)

  return {
    enabledProviders,
    refreshTtlMinutes,
    providerOptions: {
      ...(Object.keys(deepgram).length > 0 ? { deepgram: deepgram as { projectId?: string; balanceId?: string } } : {}),
      ...(Object.keys(kilo).length > 0 ? { kilo: kilo as { organizationId?: string } } : {}),
      ...(Object.keys(tavily).length > 0 ? { tavily: tavily as { projectId?: string } } : {}),
      ...(Object.keys(chatgptCodex).length > 0 ? { chatgptCodex: chatgptCodex as { codexCommand?: string } } : {}),
    },
  }
}

export const SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    enabledProviders: { type: 'array', items: { enum: [...PROVIDER_IDS] }, uniqueItems: true },
    refreshTtlMinutes: { type: 'integer', minimum: 5, maximum: 1440, default: 15 },
    providerOptions: { type: 'object' },
  },
  additionalProperties: false,
} as const
