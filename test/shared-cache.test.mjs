import assert from 'node:assert/strict'
import test from 'node:test'
import { createUsageDashboardService, UsageDashboardError, apply } from '../lib/index.js'
import { browserFixture, nodes, htmlOf } from './helpers/browser-fixture.mjs'

const at = '2026-10-23T00:00:00.000Z'
const credentials = { resolve: async () => undefined }
const good = remaining => ({ providerId: 'deepseek', displayName: 'DeepSeek', stability: 'stable', state: 'fresh', metrics: [{ kind: 'balance', remaining, currency: 'CNY' }] })
const tick = () => new Promise(resolve => setImmediate(resolve))
const response = value => ({ status: 200, ok: true, json: async () => ({ ok: true, value }) })
function memoryStore() {
  let value
  return { read: async () => structuredClone(value), write: async next => { value = structuredClone(next) }, value: () => value }
}
function options(snapshotStore, refresh, now = () => new Date(at)) {
  return { credentials, snapshotStore, now, settings: { enabledProviders: ['deepseek'], refreshTtlMinutes: 15 }, adapters: [{ id: 'deepseek', displayName: 'DeepSeek', stability: 'stable', credentialReferences: [], refresh }] }
}
async function call(service, payload = {}) {
  const result = await service.handle('snapshot', payload)
  assert.equal(result.ok, true)
  return result.value
}

test('devices and a recreated service reuse the shared, persisted snapshot without provider calls', async () => {
  const store = memoryStore(); let requests = 0
  const config = options(store, async () => { requests++; return good(12) })
  const desktop = createUsageDashboardService(config)
  assert.equal((await call(desktop, { cacheOnly: true })).needsRefresh, true)
  assert.equal(requests, 0)
  await call(desktop)
  assert.equal(requests, 1)
  assert.ok(store.value())
  assert.equal((await call(desktop, { cacheOnly: true })).needsRefresh, false)
  assert.equal((await call(desktop)).providers[0].metrics[0].remaining, 12)
  const restarted = createUsageDashboardService(config)
  const phone = await call(restarted, { cacheOnly: true })
  assert.equal(phone.providers[0].metrics[0].remaining, 12)
  assert.equal(phone.providers[0].fetchedAt, at)
  assert.equal(phone.needsRefresh, false)
  await call(restarted)
  assert.equal(requests, 1)
})

test('expired shared data returns immediately during a single refresh requested by multiple devices', async () => {
  const store = memoryStore(); let nowMs = Date.parse(at); let requests = 0; let finish
  const config = options(store, async () => { requests++; return requests === 1 ? good(12) : new Promise(resolve => { finish = () => resolve(good(25)) }) }, () => new Date(nowMs))
  await call(createUsageDashboardService(config))
  nowMs += 16 * 60_000
  const service = createUsageDashboardService(config)
  const cached = await call(service, { cacheOnly: true })
  assert.equal(cached.providers[0].metrics[0].remaining, 12)
  assert.equal(cached.needsRefresh, true)
  assert.equal(requests, 1)
  const desktop = call(service); const phone = call(service)
  await tick()
  assert.equal(requests, 2)
  assert.equal((await call(service, { cacheOnly: true })).providers[0].metrics[0].remaining, 12)
  finish()
  const results = await Promise.all([desktop, phone])
  assert.ok(results.every(result => result.providers[0].metrics[0].remaining === 25))
  assert.equal((await call(service, { cacheOnly: true })).needsRefresh, false)
  assert.equal((await call(createUsageDashboardService(config), { cacheOnly: true })).providers[0].metrics[0].remaining, 25)
})

test('refresh failure after restart preserves and persists original data times without extending expiry', async () => {
  const store = memoryStore(); let nowMs = Date.parse(at); let fail = false
  const config = options(store, async () => { if (fail) throw new UsageDashboardError('provider-timeout', 'private diagnostic'); return good(12) }, () => new Date(nowMs))
  const original = (await call(createUsageDashboardService(config))).providers[0]
  nowMs += 16 * 60_000; fail = true
  const failed = (await call(createUsageDashboardService(config))).providers[0]
  assert.equal(failed.state, 'stale')
  assert.equal(failed.metrics[0].remaining, 12)
  assert.equal(failed.fetchedAt, original.fetchedAt)
  assert.equal(failed.expiresAt, original.expiresAt)
  assert.equal(failed.attemptedAt, new Date(nowMs).toISOString())
  const restored = await call(createUsageDashboardService(config), { cacheOnly: true })
  assert.equal(restored.providers[0].state, 'stale')
  assert.equal(restored.providers[0].fetchedAt, at)
  assert.equal(restored.needsRefresh, true)
  assert.equal(JSON.stringify(store.value()).includes('private diagnostic'), false)
})

test('credential and setting changes invalidate persisted snapshots and discard old in-flight results', async () => {
  const store = memoryStore(); let requests = 0; let finish
  const config = options(store, async () => { requests++; return requests === 2 ? new Promise(resolve => { finish = () => resolve(good(99)) }) : good(12) })
  const service = createUsageDashboardService(config)
  await call(service)
  const pending = call(service, { force: true }); await tick()
  await service.observeCredentialUpdate('DEEPSEEK_API_KEY')
  finish(); await pending
  assert.deepEqual((await call(createUsageDashboardService(config), { cacheOnly: true })).providers, [])
  await call(service)
  const changed = await service.handle('settings/write', { settings: { enabledProviders: [] } })
  assert.equal(changed.ok, true)
  assert.deepEqual((await call(service, { cacheOnly: true })).providers, [])
  assert.deepEqual((await call(createUsageDashboardService(config), { cacheOnly: true })).providers, [])
})

test('a delayed persistence read cannot resurrect data after credential invalidation', async () => {
  const store = memoryStore(); const config = options(store, async () => good(12))
  await call(createUsageDashboardService(config))
  const old = structuredClone(store.value()); let finish
  const delayed = { ...store, read: () => new Promise(resolve => { finish = () => resolve(old) }) }
  const service = createUsageDashboardService({ ...config, snapshotStore: delayed })
  const pending = call(service, { cacheOnly: true }); await tick()
  await service.observeCredentialUpdate('DEEPSEEK_API_KEY')
  finish()
  assert.deepEqual((await pending).providers, [])
  assert.deepEqual((await call(createUsageDashboardService(config), { cacheOnly: true })).providers, [])
})

test('persistence projects display fields and ignores incompatible, oversized or unavailable records', async () => {
  const store = memoryStore()
  const config = options(store, async () => ({ ...good(0), token: 'fixture-private-extra', warning: 'fixture-private-extra' }))
  await call(createUsageDashboardService(config))
  assert.equal(JSON.stringify(store.value()).includes('fixture-private-extra'), false)
  const raw = structuredClone(store.value())
  for (const invalid of [{ ...raw, version: 99 }, { ...raw, scope: 'different configuration' }, { ...raw, extra: 'x'.repeat(65537) }, { ...raw, providers: [{ ...raw.providers[0], metrics: [{ kind: 'balance', currency: 'CNY', remaining: null }] }] }]) {
    const service = createUsageDashboardService({ ...config, snapshotStore: { read: async () => invalid, write: async () => {} } })
    const snapshot = await call(service, { cacheOnly: true })
    assert.deepEqual(snapshot.providers, [])
    assert.equal(snapshot.needsRefresh, true)
  }
  const broken = createUsageDashboardService({ ...config, snapshotStore: { read: async () => { throw new Error('private read failure') }, write: async () => { throw new Error('private write failure') } } })
  assert.equal((await call(broken)).providers[0].metrics[0].remaining, 0)
})

test('host record storage survives reactivation without reading real credentials or provider traffic', async () => {
  const records = new Map(); let requests = 0
  const activate = () => {
    const routes = []
    const dispose = apply({ webServer: { register: route => { routes.push(route); return () => {} } }, connection: { requestRejection: () => undefined }, credentials: { resolve: async () => 'fixture-only-api-key', readRecord: async key => records.get(key), modifyRecord: async (key, mutate) => { const value = await mutate(records.get(key)); records.set(key, value); return value } }, providerFetch: async () => { requests++; return { status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '12' }] }) } }, now: () => new Date(at) }, { enabledProviders: ['deepseek'] })
    return { dispose, read: async payload => {
      let result
      await routes.find(route => route.path.endsWith('/snapshot')).handler({ method: 'POST', headers: { 'content-type': 'application/json' }, on: (event, fn) => { if (event === 'data') fn(JSON.stringify(payload)); if (event === 'end') fn() } }, { writeHead: () => {}, end: body => { result = JSON.parse(body) } })
      return result
    } }
  }
  const first = activate(); await first.read({}); first.dispose()
  assert.equal(requests, 1)
  assert.ok(records.has('dsh-usage-dashboard/snapshots'))
  assert.equal(JSON.stringify(records.get('dsh-usage-dashboard/snapshots')).includes('fixture-only-api-key'), false)
  const second = activate(); const cached = await second.read({ cacheOnly: true }); second.dispose()
  assert.equal(cached.value.providers[0].metrics[0].remaining, 12)
  assert.equal(cached.value.needsRefresh, false)
  assert.equal(requests, 1)
})

test('a new browser uses fresh server snapshots without starting provider refreshes', async () => {
  const payloads = []
  const fixture = browserFixture({ fetch: async (path, options) => { const payload = JSON.parse(options.body); payloads.push(payload); return response(path.endsWith('/settings') ? { credentials: [] } : { providers: [good(12)], needsRefresh: false }) } })
  fixture.render(); await fixture.flushEffects()
  assert.match(htmlOf(fixture.render()), /12 CNY/)
  assert.equal(payloads.filter(payload => payload.cacheOnly === true).length, 1)
  assert.equal(payloads.length, 2)
})

test('a new browser displays expired shared data while the server refresh is pending', async () => {
  let finish; const payloads = []
  const fixture = browserFixture({ fetch: (path, options) => {
    const payload = JSON.parse(options.body); payloads.push(payload)
    if (path.endsWith('/settings')) return Promise.resolve(response({ credentials: [] }))
    if (payload.cacheOnly === true) return Promise.resolve(response({ providers: [good(12)], needsRefresh: true }))
    return new Promise(resolve => { finish = () => resolve(response({ providers: [good(25)] })) })
  } })
  fixture.render(); await fixture.flushEffects()
  assert.match(htmlOf(fixture.render()), /12 CNY/)
  assert.match(htmlOf(fixture.render()), /正在更新，暫時顯示上次記錄/)
  assert.equal(nodes(fixture.render(), node => node.props['data-provider']).length, 1)
  assert.equal(payloads.length, 3)
  finish(); await tick()
  assert.match(htmlOf(fixture.render()), /25 CNY/)
  assert.doesNotMatch(htmlOf(fixture.render()), /正在更新，暫時顯示上次記錄/)
})

test('two independent browsers use the same service and make only one provider request and one store write', async () => {
  const store = memoryStore(); let requests = 0; let writes = 0
  const service = createUsageDashboardService(options({ ...store, write: async value => { writes++; await store.write(value) } }, async () => { requests++; return good(12) }))
  const fetch = async (path, options) => {
    const result = await service.handle(path.endsWith('/settings') ? 'settings/read' : 'snapshot', JSON.parse(options.body))
    return { status: 200, ok: true, json: async () => result }
  }
  const desktop = browserFixture({ fetch }); desktop.render(); await desktop.flushEffects()
  assert.match(htmlOf(desktop.render()), /12 CNY/)
  const phone = browserFixture({ fetch }); phone.render(); await phone.flushEffects()
  assert.match(htmlOf(phone.render()), /12 CNY/)
  assert.equal(requests, 1)
  assert.equal(writes, 1)
})

test('cache-only mode refuses forced or malformed requests and credential rejection removes persisted numbers', async () => {
  const store = memoryStore(); let requests = 0; let rejected = false
  const config = options(store, async () => { requests++; if (rejected) throw new UsageDashboardError('credential-rejected', 'private key'); return good(12) })
  const service = createUsageDashboardService(config)
  for (const payload of [{ cacheOnly: true, force: true }, { cacheOnly: 'true' }]) {
    const result = await service.handle('snapshot', payload)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bad-request')
  }
  assert.equal(requests, 0)
  await call(service); rejected = true
  const failed = await call(service, { force: true })
  assert.equal(failed.providers[0].state, 'error')
  assert.deepEqual(failed.providers[0].metrics, [])
  assert.deepEqual((await call(createUsageDashboardService(config), { cacheOnly: true })).providers, [])
})
