import assert from 'node:assert/strict'
import test from 'node:test'
import { createUsageDashboardService, UsageDashboardError, UsageDashboardCache, normalizeSettings, apply, inject } from '../lib/index.js'

const credentials = { resolve: async () => undefined }
const provider = {
  id: 'openrouter', displayName: 'OpenRouter', stability: 'stable', credentialReferences: [],
  refresh: async () => ({ providerId: 'openrouter', displayName: 'OpenRouter', stability: 'stable', state: 'fresh', metrics: [] }),
}

test('manual activity survives service recreation and separates attempts from data timestamps', async () => {
  let now = new Date('2026-10-03T03:30:00Z')
  let activity = {}
  const activityStore = { read: async () => activity, update: async (change) => (activity = change(activity)) }
  const options = { credentials, activityStore, adapters: [provider], now: () => now, settings: { enabledProviders: ['openrouter'] } }
  let service = createUsageDashboardService(options)
  const initial = await service.handle('snapshot', {})
  assert.equal(initial.value.activity.lastManualRefresh, undefined)
  const refreshed = await service.handle('snapshot', { force: true, reason: 'manual' })
  assert.equal(refreshed.value.activity.lastManualRefresh.requestedAt, now.toISOString())
  assert.equal(refreshed.value.activity.lastManualRefresh.completedAt, now.toISOString())
  assert.equal(refreshed.value.activity.lastManualRefresh.outcome, 'complete')
  now = new Date('2026-10-03T04:00:00Z')
  service = createUsageDashboardService(options)
  const reopened = await service.handle('snapshot', {})
  assert.equal(reopened.value.activity.lastManualRefresh.requestedAt, '2026-10-03T03:30:00.000Z')
  await service.observeCredentialUpdate('OPENROUTER_API_KEY')
  const settings = await service.handle('settings/read', {})
  assert.equal(settings.value.credentials.find(row => row.reference === 'OPENROUTER_API_KEY').updatedAt, now.toISOString())
  assert.deepEqual(Object.keys(activity.credentialUpdatedAt), ['OPENROUTER_API_KEY'])
  await service.observeCredentialUpdate('NOT_ALLOWED')
  assert.deepEqual(Object.keys(activity.credentialUpdatedAt), ['OPENROUTER_API_KEY'])
})

test('failed refresh retains the last good data time and reports a failed manual refresh', async () => {
  let fail = false
  let now = new Date('2026-10-03T03:30:00Z')
  const service = createUsageDashboardService({ credentials, now: () => now, settings: { enabledProviders: ['openrouter'] }, adapters: [{ ...provider, refresh: async (...args) => {
    if (fail) throw new UsageDashboardError('provider-http', 'Service unavailable', { status: 503 })
    return provider.refresh(...args)
  } }] })
  const first = await service.handle('snapshot', {})
  now = new Date('2026-10-03T03:40:00Z'); fail = true
  const second = await service.handle('snapshot', { force: true, reason: 'manual' })
  assert.equal(second.value.providers[0].state, 'stale')
  assert.equal(second.value.providers[0].fetchedAt, first.value.providers[0].fetchedAt)
  assert.equal(second.value.providers[0].attemptedAt, now.toISOString())
  assert.equal(second.value.activity.lastManualRefresh.outcome, 'failed')
  const reopened = await service.handle('snapshot', {})
  assert.equal(reopened.value.providers[0].state, 'stale')
  assert.equal(reopened.value.providers[0].fetchedAt, first.value.providers[0].fetchedAt)
})

test('missing credentials are a configuration state, and are retried after a credential update', async () => {
  let configured = false
  const adapter = { ...provider, refresh: async () => {
    if (!configured) throw new UsageDashboardError('credential-missing', 'Configure a key')
    return provider.refresh()
  } }
  const cache = new UsageDashboardCache([adapter], credentials, async () => { throw new Error('no network') }, normalizeSettings({}))
  const missing = await cache.snapshot(['openrouter'])
  assert.equal(missing.providers[0].state, 'needs-configuration')
  assert.equal(missing.providers[0].fetchedAt, undefined)
  assert.equal(missing.providers[0].errorCode, 'credential-missing')
  configured = true
  assert.equal((await cache.snapshot(['openrouter'])).providers[0].state, 'fresh')
})

test('a credential update prevents an old in-flight result from repopulating the cache', async () => {
  let releaseOld
  let calls = 0
  const cache = new UsageDashboardCache([{ ...provider, refresh: async () => {
    calls += 1
    if (calls === 1) return new Promise(resolve => { releaseOld = () => resolve({ providerId: 'openrouter', displayName: 'Old key', state: 'fresh', metrics: [] }) })
    return { providerId: 'openrouter', displayName: 'New key', state: 'fresh', metrics: [] }
  } }], credentials, async () => { throw new Error('no network') }, normalizeSettings({}))
  const old = cache.snapshot(['openrouter'])
  await new Promise(resolve => setImmediate(resolve))
  cache.clear()
  assert.equal((await cache.snapshot(['openrouter'])).providers[0].displayName, 'New key')
  releaseOld(); await old
  assert.equal((await cache.snapshot(['openrouter'])).providers[0].displayName, 'New key')
  assert.equal(calls, 2)
})

test('host waits for auth and credentials and supports allowlisted Models API-key records', async () => {
  assert.deepEqual(inject, ['webServer', 'connection', 'credentials'])
  const routes = []; const records = new Map(); const listeners = new Map(); const requests = []
  const secret = 'fixture-model-api-key'
  records.set('llm-pi-ai/deepseek', { kind: 'api-key', key: secret })
  apply({
    webServer: { register: route => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    credentials: {
      resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: true }),
      readRecord: async key => records.get(key),
      describeRecord: async key => ({ configured: records.has(key), kind: records.get(key)?.kind, writable: true }),
      modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); records.set(key, next); return next },
    },
    providerFetch: async request => { requests.push(request); return { status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '12' }] }) } },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
    now: () => new Date('2026-10-03T03:30:00Z'),
  }, { enabledProviders: ['deepseek'] })
  const call = async suffix => {
    let result
    await routes.find(route => route.path.endsWith(suffix)).handler({ method: 'POST', headers: { 'content-type': 'application/json' }, on: (event, callback) => { if (event === 'data') callback('{}'); if (event === 'end') callback() } }, { writeHead: () => {}, end: body => { result = JSON.parse(body) } })
    return result.value
  }
  const snapshot = await call('/snapshot')
  assert.equal(snapshot.providers[0].state, 'fresh')
  assert.equal(requests[0].headers.Authorization, `Bearer ${secret}`)
  const status = await call('/settings')
  assert.equal(status.credentials.find(row => row.reference === 'DEEPSEEK_API_KEY').source, 'models')
  assert.equal(JSON.stringify(status).includes(secret), false)
  await listeners.get('credentials/record-updated')('llm-pi-ai/deepseek')
  assert.equal((await call('/settings')).credentials.find(row => row.reference === 'DEEPSEEK_API_KEY').updatedAt, '2026-10-03T03:30:00.000Z')
  assert.equal(JSON.stringify(records.get('dsh-usage-dashboard/activity')).includes(secret), false)
})

test('model API-key fallback respects explicit references and never interprets OAuth grants', async () => {
  for (const kind of ['api-key', 'grant']) {
    const routes = []; const requests = []
    const direct = kind === 'api-key' ? 'fixture-explicit-key' : undefined
    apply({
      webServer: { register: route => { routes.push(route); return () => {} } },
      connection: { requestRejection: () => undefined },
      credentials: { resolve: async () => direct, readRecord: async () => ({ kind, key: 'fixture-record-key', payload: { accessToken: 'fixture-grant' } }) },
      providerFetch: async request => { requests.push(request); return { status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '10' }] }) } },
    }, { enabledProviders: ['deepseek'] })
    let result
    await routes.find(route => route.path.endsWith('/snapshot')).handler({ method: 'POST', headers: { 'content-type': 'application/json' }, on: (event, callback) => { if (event === 'data') callback('{}'); if (event === 'end') callback() } }, { writeHead: () => {}, end: body => { result = JSON.parse(body) } })
    if (kind === 'api-key') assert.equal(requests[0].headers.Authorization, `Bearer ${direct}`)
    else { assert.equal(requests.length, 0); assert.equal(result.value.providers[0].state, 'needs-configuration') }
    assert.equal(JSON.stringify(result).includes('fixture-'), false)
  }
})
