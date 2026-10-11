export type UsageLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type UsageLogValue = string | number | boolean | null | undefined
export type UsageLogFields = Readonly<Record<string, UsageLogValue>>

export interface UsageLogger {
  debug(event: string, fields?: UsageLogFields): void
  info(event: string, fields?: UsageLogFields): void
  warn(event: string, fields?: UsageLogFields): void
  error(event: string, fields?: UsageLogFields): void
}

export interface HostLoggerLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

const ALLOWED_FIELDS = new Set([
  'requestId', 'providerId', 'adapter', 'cache', 'force', 'durationMs', 'status',
  'errorCode', 'httpStatus', 'responseBytes', 'concurrency', 'queueDepth',
  'endpoint', 'authority', 'metricCount', 'stale', 'timeoutMs', 'endpointPath',
])

const SECRET_PATTERN = /(?:bearer|secret|token|cookie|session.?id|authorization|api.?key|password)\s*[:=]\s*[^\s,;]+/gi
const TOKEN_PATTERN = /(?:sk|pk|key)[-_][A-Za-z0-9_-]{8,}/gi

function safeValue(value: UsageLogValue): UsageLogValue {
  if (typeof value !== 'string') return value
  const redacted = value.replace(SECRET_PATTERN, '[redacted]').replace(TOKEN_PATTERN, '[redacted]')
  return redacted.length > 160 ? `${redacted.slice(0, 157)}...` : redacted
}

function safeFields(fields: UsageLogFields | undefined): Record<string, UsageLogValue> {
  if (fields === undefined) return {}
  const output: Record<string, UsageLogValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(key)) output[key] = safeValue(value)
  }
  return output
}

function format(event: string, fields?: UsageLogFields): string {
  const payload = safeFields(fields)
  return Object.keys(payload).length === 0
    ? `[dsh-usage-dashboard] ${event}`
    : `[dsh-usage-dashboard] ${event} ${JSON.stringify(payload)}`
}

export const NOOP_USAGE_LOGGER: UsageLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

export function createUsageLogger(hostLogger?: HostLoggerLike): UsageLogger {
  if (hostLogger === undefined) return NOOP_USAGE_LOGGER
  return {
    debug: (event, fields) => hostLogger.debug(format(event, fields)),
    info: (event, fields) => hostLogger.info(format(event, fields)),
    warn: (event, fields) => hostLogger.warn(format(event, fields)),
    error: (event, fields) => hostLogger.error(format(event, fields)),
  }
}

export function redactLogText(value: string): string {
  return String(safeValue(value))
}
