import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createUsageDashboardService,
  createUsageLogger,
} from '../lib/index.js'

function resolver(values = {}) {
  return { resolve: async (reference) => values[reference] }
}

function response(body, status = 200, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { status, headers, text: async () => text }
}

function captureLogger() {
  const lines = []
  const host = {
    debug: (line) => lines.push(line),
    info: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  }
  return { lines, logger: createUsageLogger(host) }
}

test('credential/write rejects unknown references and invalid values without touching the store', async () => {
  let calls = 0
  const service = createUsageDashboardService({
    credentials: resolver(),
    credentialStore: { store: async () => { calls += 1 } },
    fetcher: async () => response('{}'),
    settings: { enabledProviders: ['openrouter'], refreshTtlMinutes: 15 },
  })
  const unknown = await service.handle('credential/write', { reference: 'NOT_A_REAL_KEY', value: 'valid-secret-value-123' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'bad-request')
  assert.equal(calls, 0)

  const short = await service.handle('credential/write', { reference: 'OPENROUTER_API_KEY', value: 'short' })
  assert.equal(short.ok, false)
  assert.equal(short.error.code, 'bad-request')
  assert.equal(calls, 0)

  const newline = await service.handle('credential/write', { reference: 'OPENROUTER_API_KEY', value: 'valid-but-\nnewline-secret' })
  assert.equal(newline.ok, false)
  assert.equal(newline.error.code, 'bad-request')
  assert.equal(calls, 0)
})

test('credential/write stores via host service, clears cache, and never returns the secret', async () => {
  const captured = captureLogger()
  const stored = new Map()
  const service = createUsageDashboardService({
    credentials: resolver({ OPENROUTER_API_KEY: 'old-value' }),
    credentialStore: { store: async (reference, value) => { stored.set(reference, value) } },
    credentialStatus: async (reference) => ({ configured: stored.has(reference), writable: true }),
    fetcher: async () => response({ data: { total_credits: 10, total_usage: 4 } }),
    settings: { enabledProviders: ['openrouter'], refreshTtlMinutes: 15 },
    logger: captured.logger,
  })
  const secret = 'sk-test-credential-write-12345'
  const result = await service.handle('credential/write', { reference: 'OPENROUTER_API_KEY', value: secret })
  assert.equal(result.ok, true)
  assert.equal(result.value.reference, 'OPENROUTER_API_KEY')
  assert.equal(result.value.configured, true)
  assert.equal(stored.get('OPENROUTER_API_KEY'), secret)
  // Response, settings snapshot, and logs must never contain the secret.
  assert.equal(JSON.stringify(result).includes(secret), false)
  const joined = captured.lines.join('\n')
  assert.equal(joined.includes(secret), false)
  assert.match(joined, /credential\/write/)
})

test('credential/write without a host store guides back to Harness management', async () => {
  const service = createUsageDashboardService({
    credentials: resolver(),
    fetcher: async () => response('{}'),
    settings: { enabledProviders: [], refreshTtlMinutes: 15 },
  })
  const result = await service.handle('credential/write', { reference: 'TAVILY_API_KEY', value: 'tv-valid-secret-12345' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'credential-not-writable')
})

test('credential/write maps store failures to credential-rejected without leaking details', async () => {
  const captured = captureLogger()
  const service = createUsageDashboardService({
    credentials: resolver(),
    credentialStore: { store: async () => { throw new Error('host says sk-super-secret-value is bad') } },
    fetcher: async () => response('{}'),
    settings: { enabledProviders: [], refreshTtlMinutes: 15 },
    logger: captured.logger,
  })
  const result = await service.handle('credential/write', { reference: 'DEEPGRAM_API_KEY', value: 'dg-valid-secret-12345' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'credential-rejected')
  assert.equal(JSON.stringify(result).includes('sk-super-secret-value'), false)
  assert.equal(captured.lines.join('\n').includes('sk-super-secret-value'), false)
})
