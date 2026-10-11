import type { ProviderId } from './types.js'

export interface CredentialReference {
  readonly reference: string
  readonly label: string
  readonly kind: 'api-key' | 'session' | 'cookie'
}

export interface CredentialStatus {
  readonly reference: string
  readonly label: string
  readonly kind: CredentialReference['kind']
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
  readonly updatedAt?: string
}

export type CredentialStatusResolver = (reference: string) => Promise<{ readonly configured: boolean; readonly source?: string; readonly writable: boolean }>

/** Only API-key records with verified Harness provider identities may be reused. */
export const HOST_CREDENTIAL_RECORDS: Readonly<Record<string, string>> = {
  OPENROUTER_API_KEY: 'llm-pi-ai/openrouter',
  DEEPSEEK_API_KEY: 'llm-pi-ai/deepseek',
  OPENCODE_GO_API_KEY: 'llm-pi-ai/opencode-go',
}

export const CREDENTIAL_REFERENCES: Readonly<Record<ProviderId, readonly CredentialReference[]>> = {
  openrouter: [{ reference: 'OPENROUTER_API_KEY', label: 'Management API key', kind: 'api-key' }],
  deepseek: [{ reference: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key', kind: 'api-key' }],
  kilo: [{ reference: 'KILO_API_KEY', label: 'Kilo API key', kind: 'api-key' }],
  deepgram: [{ reference: 'DEEPGRAM_API_KEY', label: 'Management API key', kind: 'api-key' }],
  serper: [
    { reference: 'SERPER_API_KEY', label: 'API key', kind: 'api-key' },
    { reference: 'DSH_USAGE_SERPER_SESSION', label: 'Dashboard session', kind: 'session' },
  ],
  'chatgpt-codex': [],
  'opencode-go': [{ reference: 'OPENCODE_GO_API_KEY', label: 'OpenCode Go API key', kind: 'api-key' }],
  tavily: [{ reference: 'TAVILY_API_KEY', label: 'API key', kind: 'api-key' }],
  'brave-search': [
    { reference: 'BRAVE_SEARCH_API_KEY', label: 'API key', kind: 'api-key' },
    { reference: 'DSH_USAGE_BRAVE_SESSION', label: 'Dashboard session', kind: 'session' },
  ],
}

export function hasSecret(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

const KNOWN_REFERENCES = new Map<string, { providerId: ProviderId; kind: CredentialReference['kind'] }>()
for (const [providerId, references] of Object.entries(CREDENTIAL_REFERENCES) as Array<[ProviderId, readonly CredentialReference[]]>) {
  for (const item of references) {
    if (!KNOWN_REFERENCES.has(item.reference)) {
      KNOWN_REFERENCES.set(item.reference, { providerId, kind: item.kind })
    }
  }
}

/** Allowlist check for credential/write: only references declared above may be stored. */
export function describeKnownReference(reference: string): { providerId: ProviderId; kind: CredentialReference['kind'] } | undefined {
  return KNOWN_REFERENCES.get(reference)
}

/**
 * Validate a candidate secret without recording it.
 * Returns the trimmed value when acceptable, otherwise undefined.
 * Boundary: 8..4096 chars after trim; no value is ever logged by callers.
 */
export function validateSecretCandidate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length < 8 || trimmed.length > 4096) return undefined
  if (/[\r\n]/.test(trimmed)) return undefined
  return trimmed
}

export function redactSecret(_value: string): string {
  return '••••'
}
