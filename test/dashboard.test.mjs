import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import {
  CREDENTIAL_REFERENCES,
  ChatGptCodexAdapter,
  DeepgramAdapter,
  DeepseekAdapter,
  OpenRouterAdapter,
  OpenCodeGoAdapter,
  TavilyAdapter,
  UnsupportedAdapter,
  UsageDashboardCache,
  UsageDashboardError,
  createDefaultAdapters,
  createUsageLogger,
  createUsageDashboardService,
  createDashboardHttpRoutes,
  DASHBOARD_HTTP_PREFIX,
  DASHBOARD_HTTP_PATHS,
  apply,
  inject,
  normalizeCodexRateLimits,
  normalizeSettings,
  publicError,
  registerLoopbackRpc,
  requestJson,
} from '../lib/index.js'
import { renderDashboardHtml, UsageDashboardController } from '../lib/client/index.js'

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

test('host waits for WebServer, session authentication and credentials', () => {
  assert.deepEqual(inject, ['webServer', 'connection', 'credentials'])
})

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

function context(body, values, now = () => new Date(), status = 200, calls = []) {
  return {
    credentials: resolver(values),
    fetch: async (request) => { calls.push(request); return response(body, status) },
    settings: normalizeSettings({ enabledProviders: ['deepgram', 'tavily'], providerOptions: { deepgram: { projectId: 'proj', balanceId: 'bal' } } }),
    now,
  }
}

test('OpenRouter adapter parses success and zero balance without exposing the key', async () => {
  const body = await fixture('openrouter.success.json')
  const calls = []
  const snapshot = await new OpenRouterAdapter().refresh(context(body, { OPENROUTER_API_KEY: 'sk-test-secret-value' }, undefined, 200, calls), new AbortController().signal)
  assert.equal(snapshot.metrics[0].remaining, 21.25)
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/credits')
  assert.match(calls[0].headers.Authorization, /^Bearer /)
  assert.equal(snapshot.warning, undefined)
  const zero = await new OpenRouterAdapter().refresh(context(await fixture('openrouter.zero.json'), { OPENROUTER_API_KEY: 'sk-test-secret-value' }), new AbortController().signal)
  assert.equal(zero.metrics[0].remaining, 0)
  const changed = await new OpenRouterAdapter().refresh(context(await fixture('openrouter.changed.json'), { OPENROUTER_API_KEY: 'sk-test-secret-value' }), new AbortController().signal)
  assert.equal(changed.metrics[0].remaining, 20)
})

test('DeepSeek adapter parses official balance like OpenRouter without exposing the key', async () => {
  const calls = []
  const snapshot = await new DeepseekAdapter().refresh(context(await fixture('deepseek.success.json'), { DEEPSEEK_API_KEY: 'sk-test-secret-value' }, undefined, 200, calls), new AbortController().signal)
  assert.equal(snapshot.stability, 'stable')
  assert.equal(snapshot.state, 'fresh')
  assert.equal(snapshot.metrics.length, 1)
  assert.equal(snapshot.metrics[0].remaining, 110)
  assert.equal(snapshot.metrics[0].currency, 'CNY')
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.match(calls[0].headers.Authorization, /^Bearer /)
  assert.equal(snapshot.warning, undefined)
  const multi = await new DeepseekAdapter().refresh(context(await fixture('deepseek.multi.json'), { DEEPSEEK_API_KEY: 'sk-test-secret-value' }), new AbortController().signal)
  assert.equal(multi.metrics.length, 2)
  assert.deepEqual(multi.metrics.map((metric) => [metric.currency, metric.remaining]), [['CNY', 50.25], ['USD', 7.5]])
  const low = await new DeepseekAdapter().refresh(context({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] }, { DEEPSEEK_API_KEY: 'sk-test-secret-value' }), new AbortController().signal)
  assert.match(low.warning, /insufficient/)
  await assert.rejects(async () => new DeepseekAdapter().refresh(context({ is_available: true, balance_infos: [] }, { DEEPSEEK_API_KEY: 'sk-test-secret-value' }), new AbortController().signal), (error) => error.code === 'provider-invalid-response')
  await assert.rejects(async () => new DeepseekAdapter().refresh(context({ is_available: true }, { DEEPSEEK_API_KEY: 'sk-test-secret-value' }), new AbortController().signal), (error) => error.code === 'provider-invalid-response')
  await assert.rejects(async () => new DeepseekAdapter().refresh(context(await fixture('deepseek.success.json'), {}), new AbortController().signal), (error) => error.code === 'credential-missing')
})

test('provider adapters reject missing fields and missing credentials', async () => {
  const missing = await fixture('openrouter.missing.json')
  await assert.rejects(() => new OpenRouterAdapter().refresh(context(missing, { OPENROUTER_API_KEY: 'sk-test-secret-value' }), new AbortController().signal), (error) => error.code === 'provider-invalid-response')
  await assert.rejects(() => new OpenRouterAdapter().refresh(context({}, {}), new AbortController().signal), (error) => error.code === 'credential-missing')
})

test('Deepgram and Tavily adapters normalize configured and multi-window usage', async () => {
  const deepgram = await new DeepgramAdapter().refresh(context(await fixture('deepgram.success.json'), { DEEPGRAM_API_KEY: 'dg-secret' }), new AbortController().signal)
  assert.equal(deepgram.metrics[0].remaining, 12.75)
  const tavily = await new TavilyAdapter().refresh(context(await fixture('tavily.multi.json'), { TAVILY_API_KEY: 'tv-secret' }), new AbortController().signal)
  assert.equal(tavily.metrics.length, 3)
  assert.deepEqual(tavily.metrics.map((metric) => metric.used), [12, 20, 3])
})

test('OpenCode Go adapter parses all usage windows with a fixed endpoint and bearer key', async () => {
  const body = await fixture('opencode-go.success.json')
  const calls = []
  const snapshot = await new OpenCodeGoAdapter().refresh(context(body, { OPENCODE_GO_API_KEY: 'og-secret-value' }, undefined, 200, calls), new AbortController().signal)
  assert.equal(snapshot.stability, 'experimental')
  assert.equal(snapshot.state, 'fresh')
  assert.deepEqual(snapshot.metrics.map((metric) => [metric.label, metric.used, metric.limit, metric.unit, metric.window.kind, metric.window.resetsAt]), [
    ['Rolling (5h)', 42.5, 100, 'percent', 'rolling', '2026-09-05T20:00:00.000Z'],
    ['Weekly', 0, 100, 'percent', 'calendar', '2026-09-07T00:00:00.000Z'],
    ['Monthly', 100, 100, 'percent', 'calendar', '2026-10-01T00:00:00.000Z'],
  ])
  assert.equal(calls[0].url, 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(calls[0].headers.Authorization, 'Bearer og-secret-value')
})

test('OpenCode Go adapter rejects malformed, out-of-range, and missing usage windows', async () => {
  const valid = await fixture('opencode-go.success.json')
  const cases = [
    { ...valid, usage: { ...valid.usage, rolling: { ...valid.usage.rolling, status: 'error' } } },
    { ...valid, usage: { ...valid.usage, weekly: { ...valid.usage.weekly, percent: -0.1 } } },
    { ...valid, usage: { ...valid.usage, monthly: { ...valid.usage.monthly, percent: 100.1 } } },
    { ...valid, usage: { ...valid.usage, rolling: { ...valid.usage.rolling, percent: Number.NaN } } },
    { ...valid, usage: { ...valid.usage, weekly: { ...valid.usage.weekly, resetsAt: 'not-a-date' } } },
    { usage: {} },
    {},
  ]
  for (const body of cases) {
    await assert.rejects(() => new OpenCodeGoAdapter().refresh(context(body, { OPENCODE_GO_API_KEY: 'og-secret-value' }), new AbortController().signal), (error) => error.code === 'provider-invalid-response')
  }
})

test('ChatGPT/Codex adapter supports modern and legacy rate-limit windows', async () => {
  const modern = await fixture('codex.modern.json')
  const adapter = new ChatGptCodexAdapter({ read: async () => modern })
  const snapshot = await adapter.refresh(context({}, {}), new AbortController().signal)
  assert.equal(snapshot.metrics.length, 3)
  assert.equal(snapshot.metrics[0].window.durationSeconds, 18_000)
  assert.equal(normalizeCodexRateLimits(await fixture('codex.legacy.json')).length, 2)
  const configured = await new ChatGptCodexAdapter().refresh(context({}, {}), new AbortController().signal)
  assert.equal(configured.state, 'needs-configuration')
})

test('fixed endpoint allowlist, HTTP errors, size cap, and timeout are public-safe', async () => {
  const signal = new AbortController().signal
  const policy = { providerId: 'openrouter', hostname: 'openrouter.ai', pathname: '/api/v1/credits' }
  await assert.rejects(() => requestJson(async () => response('{}'), { url: 'https://evil.example/api/v1/credits' }, policy, signal), (error) => error.code === 'endpoint-not-allowed')
  for (const status of [401, 403, 429]) {
    await assert.rejects(() => requestJson(async () => response('{}', status), { url: 'https://openrouter.ai/api/v1/credits' }, policy, signal), (error) => error.status === status)
  }
  await assert.rejects(() => requestJson(async () => response('{}', 200, { 'content-length': String(256 * 1024 + 1) }), { url: 'https://openrouter.ai/api/v1/credits' }, policy, signal), (error) => error.code === 'provider-invalid-response')
  await assert.rejects(() => requestJson(async ({ signal: requestSignal }) => new Promise((resolve, reject) => requestSignal.addEventListener('abort', () => reject(new Error('aborted')))), { url: 'https://openrouter.ai/api/v1/credits' }, policy, signal, 5), (error) => error.code === 'provider-timeout')
  assert.equal(publicError(new Error('Bearer sk-super-secret-value')).message, 'The usage provider failed without a public diagnostic.')
  assert.equal(publicError(new UsageDashboardError('provider-http', 'secret=sk-super-secret-value')).message, 'The provider returned an HTTP error.')
})

test('diagnostic logging identifies source without recording secrets or usage values', async () => {
  const captured = captureLogger()
  const logger = captured.logger
  const policy = { providerId: 'openrouter', hostname: 'openrouter.ai', pathname: '/api/v1/credits' }
  await requestJson(async () => response('{}'), { url: 'https://openrouter.ai/api/v1/credits' }, policy, new AbortController().signal, undefined, logger)
  await assert.rejects(() => requestJson(async () => response('{}'), { url: 'https://evil.example/api/v1/credits' }, policy, new AbortController().signal, undefined, logger))
  logger.info('test.secret', { endpoint: 'Bearer sk-super-secret-value', providerId: 'openrouter', responseBytes: 12 })
  const joined = captured.lines.join('\n')
  assert.match(joined, /http\.start/)
  assert.match(joined, /http\.success/)
  assert.match(joined, /http\.blocked/)
  assert.match(joined, /responseBytes/)
  assert.equal(joined.includes('sk-super-secret-value'), false)
})

test('cache enforces TTL, single-flight, bounded concurrency, and stale last-good', async () => {
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
  let calls = 0
  let fail = false
  const adapter = {
    id: 'openrouter', displayName: 'OpenRouter', stability: 'stable', credentialReferences: [],
    refresh: async (ctx) => {
      calls += 1
      if (fail) throw new UsageDashboardError('provider-http', 'temporary provider failure', { providerId: 'openrouter' })
      return { providerId: 'openrouter', displayName: 'OpenRouter', stability: 'stable', state: 'fresh', metrics: [{ kind: 'balance', currency: 'USD', remaining: 1 }], fetchedAt: ctx.now().toISOString() }
    },
  }
  const settings = normalizeSettings({ enabledProviders: ['openrouter'], refreshTtlMinutes: 5 })
  const cache = new UsageDashboardCache([adapter], resolver(), async () => response('{}'), settings, { now: () => new Date(nowMs), maxConcurrent: 3 })
  const [first, second] = await Promise.all([cache.snapshot(['openrouter']), cache.snapshot(['openrouter'])])
  assert.equal(calls, 1)
  assert.equal(first.providers[0].metrics[0].remaining, second.providers[0].metrics[0].remaining)
  nowMs += 6 * 60_000
  fail = true
  const stale = await cache.snapshot(['openrouter'])
  assert.equal(stale.providers[0].state, 'stale')
  assert.match(stale.providers[0].warning, /The provider returned an HTTP error\./)
})

test('cache and RPC diagnostics include provider and request failure source', async () => {
  const captured = captureLogger()
  let fail = false
  const adapter = {
    id: 'openrouter', displayName: 'OpenRouter', stability: 'stable', credentialReferences: [],
    refresh: async () => {
      if (fail) throw new UsageDashboardError('provider-http', 'temporary failure', { providerId: 'openrouter', status: 503 })
      return { providerId: 'openrouter', displayName: 'OpenRouter', stability: 'stable', state: 'fresh', metrics: [] }
    },
  }
  const service = createUsageDashboardService({ adapters: [adapter], credentials: resolver(), fetcher: async () => response('{}'), settings: { enabledProviders: ['openrouter'], refreshTtlMinutes: 5 }, logger: captured.logger })
  const first = await service.handle('snapshot', { providerIds: ['openrouter'] })
  assert.equal(first.ok, true)
  fail = true
  const second = await service.handle('snapshot', { providerIds: ['openrouter'], force: true })
  assert.equal(second.value.providers[0].state, 'stale')
  const joined = captured.lines.join('\n')
  assert.match(joined, /rpc\.start/)
  assert.match(joined, /rpc\.success/)
  assert.match(joined, /provider\.success/)
  assert.match(joined, /provider\.failure/)
  assert.match(joined, /stale/)
  assert.match(joined, /503/)
  assert.equal(joined.includes('temporary failure'), false)
})

test('host registration emits only a loopback registration diagnostic', () => {
  const captured = captureLogger()
  const connection = { rpc: { handle: () => () => undefined } }
  const dispose = apply({ connection, credentials: resolver(), logger: {
    debug: (line) => captured.lines.push(line),
    info: (line) => captured.lines.push(line),
    warn: (line) => captured.lines.push(line),
    error: (line) => captured.lines.push(line),
  } })
  assert.equal(typeof dispose, 'function')
  assert.match(captured.lines.join('\n'), /rpc\.registered/)
  assert.match(captured.lines.join('\n'), /loopback/)
})

test('cache never runs more than three provider refreshes at once', async () => {
  const ids = ['openrouter', 'deepgram', 'tavily', 'kilo', 'serper']
  let active = 0
  let maximum = 0
  const releases = []
  const adapters = ids.map((id) => ({
    id, displayName: id, stability: id === 'kilo' || id === 'serper' ? 'experimental' : 'stable', credentialReferences: [],
    refresh: async () => new Promise((resolve) => {
      active += 1; maximum = Math.max(maximum, active)
      releases.push(() => { active -= 1; resolve({ providerId: id, displayName: id, stability: 'stable', state: 'fresh', metrics: [] }) })
    }),
  }))
  const cache = new UsageDashboardCache(adapters, resolver(), async () => response('{}'), normalizeSettings({ refreshTtlMinutes: 5 }), { maxConcurrent: 3 })
  let done = false
  const pending = cache.snapshot(ids).then(() => { done = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(maximum, 3)
  while (!done) {
    const release = releases.shift()
    if (release !== undefined) release()
    else await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await pending
  assert.ok(maximum <= 3)
})

test('experimental providers are explicit and perform no billable probe', async () => {
  let requests = 0
  const adapter = new UnsupportedAdapter('kilo', 'Kilo', CREDENTIAL_REFERENCES.kilo.map((item) => item.reference))
  const result = await adapter.refresh({ credentials: resolver(), fetch: async () => { requests += 1; return response('{}') }, settings: normalizeSettings({}), now: () => new Date() }, new AbortController().signal)
  assert.equal(result.state, 'unsupported')
  assert.equal(requests, 0)
  assert.match(result.warning, /zero-cost/)
  assert.equal(createDefaultAdapters().filter((item) => item.stability === 'stable').length, 5)
})

test('loopback RPC has a fixed endpoint boundary and settings preserve provider order', async () => {
  const service = createUsageDashboardService({ credentials: resolver({ OPENROUTER_API_KEY: 'secret' }), credentialStatus: async () => ({ configured: true, source: 'test', writable: false }), fetcher: async () => response(await fixture('openrouter.success.json')), settings: { enabledProviders: ['openrouter', 'tavily', 'openrouter'], refreshTtlMinutes: 15 } })
  const calls = []
  const connection = { rpc: { handle: (channel, handler, options) => { calls.push({ channel, handler, options }); return () => undefined } } }
  const registration = registerLoopbackRpc(connection, service)
  assert.equal(registration.channel, '/usage-dashboard')
  assert.equal(calls[0].options.authority, 'loopback')
  assert.equal((await service.handle('not-allowed', {})).ok, false)
  const settings = await service.handle('settings/read', {})
  assert.deepEqual(settings.value.settings.enabledProviders, ['openrouter', 'tavily'])
  assert.equal(settings.value.credentials[0].configured, true)
  assert.equal(JSON.stringify(settings).includes('secret'), false)
  const snapshot = await service.handle('snapshot', { providerIds: ['openrouter'] })
  assert.equal(snapshot.value.providers[0].metrics[0].remaining, 21.25)
  const written = await service.handle('settings/write', { settings: { enabledProviders: ['tavily', 'openrouter'], refreshTtlMinutes: 0, secret: 'do-not-store' } })
  assert.deepEqual(written.value.enabledProviders, ['tavily', 'openrouter'])
  assert.equal(JSON.stringify(written).includes('do-not-store'), false)
})

test('client stays collapsed without requesting, then refreshes on expand and manual force', async () => {
  let now = 0
  let calls = 0
  const connection = { rpc: { call: async (_channel, _endpoint, payload) => { calls += 1; return { ok: true, value: { generatedAt: new Date(now).toISOString(), providers: [] } } } } }
  const controller = new UsageDashboardController(connection, ['openrouter'], 15, () => now)
  assert.equal(calls, 0)
  assert.match(renderDashboardHtml(controller.state(), 'zh-Hans'), /aria-expanded="false"/)
  await controller.expand()
  assert.equal(calls, 1)
  controller.collapse()
  now += 60_000
  await controller.expand()
  assert.equal(calls, 1)
  await controller.refresh(true)
  assert.equal(calls, 2)
  assert.match(renderDashboardHtml(controller.state(), 'zh-Hant'), /用量與額度/)
})

test('settings normalization clamps TTL and removes duplicate/unknown providers', () => {
  const settings = normalizeSettings({ enabledProviders: ['tavily', 'tavily', 'not-real', 'openrouter'], refreshTtlMinutes: 1 })
  assert.deepEqual(settings.enabledProviders, ['tavily', 'openrouter'])
  assert.equal(settings.refreshTtlMinutes, 5)
})

function fakeHttpRequest({ method = 'POST', host = '127.0.0.1:3080', remote = '127.0.0.1', body = '{}', contentType = 'application/json' } = {}) {
  return {
    method,
    headers: { host, 'content-type': contentType },
    socket: { remoteAddress: remote },
    on(event, listener) {
      if (event === 'data') listener(body)
      if (event === 'end') listener()
      return this
    },
  }
}

function fakeHttpResponse() {
  const captured = { status: 0, headers: undefined, body: undefined }
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; return this },
    end(body) { captured.body = body; return this },
  }
}

async function dispatchRoute(route, options) {
  const response = fakeHttpResponse()
  await route.handler(fakeHttpRequest(options), response)
  const raw = response.captured.body
  const json = typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('[')) ? JSON.parse(raw) : undefined
  return { status: response.captured.status, headers: response.captured.headers, body: raw, json }
}

test('dashboard HTTP routes mount as exact /api paths with the legacy channel kept as fallback', async () => {
  const service = createUsageDashboardService({ credentials: resolver(), fetcher: async () => response('{}'), settings: { enabledProviders: [], refreshTtlMinutes: 15 } })
  const routes = createDashboardHttpRoutes(service)
  assert.deepEqual(routes.map((route) => route.path), [
    `${DASHBOARD_HTTP_PREFIX}/snapshot`,
    `${DASHBOARD_HTTP_PREFIX}/settings`,
    `${DASHBOARD_HTTP_PREFIX}/settings-write`,
    `${DASHBOARD_HTTP_PREFIX}/credential`,
  ])
  assert.ok(routes.every((route) => route.kind === 'exact'))
  assert.equal(DASHBOARD_HTTP_PATHS['settings/read'], 'settings')
  assert.equal(DASHBOARD_HTTP_PATHS['credential/write'], 'credential')

  const registered = []
  const disposed = []
  const dispose = apply(
    {
      webServer: { register: (route) => { registered.push(route.path); return () => disposed.push(route.path) } },
      credentials: resolver(),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    },
    { enabledProviders: [], refreshTtlMinutes: 15 },
  )
  assert.deepEqual(registered, [
    `${DASHBOARD_HTTP_PREFIX}/snapshot`,
    `${DASHBOARD_HTTP_PREFIX}/settings`,
    `${DASHBOARD_HTTP_PREFIX}/settings-write`,
    `${DASHBOARD_HTTP_PREFIX}/credential`,
  ])
  // A host without Connection still mounts every route, and the returned disposer removes them.
  assert.equal(typeof dispose, 'function')
  assert.equal(disposed.length, 0)
  dispose()
  assert.deepEqual(disposed, [...registered].reverse())
})

test('dashboard HTTP routes answer loopback callers and refuse everything else before doing work', async () => {
  const storeCalls = []
  const service = createUsageDashboardService({
    credentials: resolver(),
    credentialStore: { store: async (reference, value) => { storeCalls.push(reference) } },
    credentialStatus: async () => ({ configured: true, writable: true }),
    fetcher: async () => response('{}'),
    settings: { enabledProviders: ['openrouter'], refreshTtlMinutes: 15 },
  })
  const routes = createDashboardHttpRoutes(service)
  const snapshot = routes.find((route) => route.path.endsWith('/snapshot'))
  const settings = routes.find((route) => route.path.endsWith('/settings'))
  const credential = routes.find((route) => route.path.endsWith('/credential'))

  const ok = await dispatchRoute(snapshot)
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.match(ok.headers['cache-control'], /no-store/)

  // Non-loopback callers are refused by the fallback fence, and nothing is probed.
  const forbidden = await dispatchRoute(snapshot, { remote: '10.0.0.9', host: 'evil.example' })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.json, undefined)

  const wrongHost = await dispatchRoute(snapshot, { host: 'evil.example' })
  assert.equal(wrongHost.status, 403)

  const wrongMethod = await dispatchRoute(snapshot, { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json, undefined)

  const wrongType = await dispatchRoute(snapshot, { contentType: 'text/plain' })
  assert.equal(wrongType.status, 415)

  const badJson = await dispatchRoute(snapshot, { body: '{not json' })
  assert.equal(badJson.status, 400)

  const settingsOk = await dispatchRoute(settings)
  assert.equal(settingsOk.status, 200)
  assert.equal(settingsOk.json.ok, true)

  const secret = 'fixture-route-value'
  const saved = await dispatchRoute(credential, { body: JSON.stringify({ reference: 'OPENROUTER_API_KEY', value: secret }) })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.ok, true)
  assert.deepEqual(storeCalls, ['OPENROUTER_API_KEY'])
  assert.equal(JSON.stringify(saved.json).includes(secret), false)
  assert.equal(String(saved.body).includes(secret), false)

  const refused = await dispatchRoute(credential, { body: JSON.stringify({ reference: 'NOT_A_REAL_KEY', value: secret }) })
  assert.equal(refused.status, 200)
  assert.equal(refused.json.ok, false)
  assert.equal(refused.json.error.code, 'bad-request')
  assert.equal(String(refused.body).includes(secret), false)
})

test('dashboard HTTP routes delegate the trust decision to Connection when it is available', async () => {
  const service = createUsageDashboardService({ credentials: resolver(), fetcher: async () => response('{}'), settings: { enabledProviders: [], refreshTtlMinutes: 15 } })
  const seen = []
  const routes = createDashboardHttpRoutes(service, { rejection: (request) => { seen.push(request); return 401 } })
  const result = await dispatchRoute(routes[0])
  assert.equal(result.status, 401)
  assert.equal(result.body, 'unauthorized')
  assert.equal(seen.length, 1)
})
