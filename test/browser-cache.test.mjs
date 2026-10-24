import assert from 'node:assert/strict'
import test from 'node:test'
import { browserFixture, nodes, htmlOf } from './helpers/browser-fixture.mjs'
import { readFile } from 'node:fs/promises'

const key = 'dsh-usage-dashboard:snapshot:v1'
const at = '2026-10-03T03:30:00.000Z'
const response = value => ({ status: 200, ok: true, json: async () => ({ ok: true, value }) })
const snapshot = (remaining = 12) => ({ generatedAt: at, providers: [{ providerId: 'deepseek', displayName: 'DeepSeek', state: 'fresh', fetchedAt: at, expiresAt: at, attemptedAt: at, metrics: [{ kind: 'balance', remaining, currency: 'CNY' }] }] })
function storage() {
  const items = new Map()
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) }
}
async function prime(localStorage, value = snapshot()) {
  const fixture = browserFixture({ localStorage, fetch: async path => response(path.endsWith('/settings') ? { credentials: [] } : value) })
  fixture.render(); await fixture.flushEffects(); fixture.dispose()
}
const card = fixture => htmlOf(nodes(fixture.render(), node => node.props['data-provider'] === 'deepseek')[0])

test('reopening shows the previous snapshot before requests finish, then replaces and persists it', async () => {
  const localStorage = storage()
  await prime(localStorage)
  let finish
  const fixture = browserFixture({ localStorage, fetch: path => path.endsWith('/settings') ? Promise.resolve(response({ credentials: [] })) : new Promise(resolve => { finish = resolve }) })
  assert.match(card(fixture), /12 CNY/)
  assert.match(card(fixture), /上次記錄/)
  assert.doesNotMatch(card(fixture), /最新/)
  assert.match(htmlOf(fixture.render()), /正在更新，暫時顯示上次記錄/)
  await fixture.flushEffects()
  assert.match(card(fixture), /12 CNY/)
  finish(response(snapshot(25)))
  await new Promise(resolve => setImmediate(resolve))
  assert.match(card(fixture), /25 CNY/)
  assert.match(card(fixture), /最新/)
  assert.doesNotMatch(htmlOf(fixture.render()), /正在更新，暫時顯示上次記錄/)
  fixture.dispose()
  const reopened = browserFixture({ localStorage })
  assert.match(card(reopened), /25 CNY/)
  assert.match(card(reopened), /datetime="2026-10-03T03:30:00.000Z"/)
})

test('network failures retain local numbers and shared stale responses preserve server data times', async () => {
  const localStorage = storage()
  await prime(localStorage)
  const before = localStorage.getItem(key)
  const offline = browserFixture({ localStorage, fetch: async () => { throw new Error('offline') } })
  offline.render(); await offline.flushEffects()
  assert.match(card(offline), /12 CNY/)
  assert.match(htmlOf(offline.render()), /網路連線失敗/)
  assert.equal(localStorage.getItem(key), before)
  offline.dispose()
  const failed = snapshot()
  failed.providers[0] = { ...failed.providers[0], state: 'stale', errorCode: 'provider-timeout', attemptedAt: '2026-10-23T00:00:00.000Z' }
  const fixture = browserFixture({ localStorage, fetch: async path => response(path.endsWith('/settings') ? { credentials: [] } : failed) })
  fixture.render(); await fixture.flushEffects()
  assert.match(card(fixture), /12 CNY/)
  assert.match(card(fixture), /資料過期/)
  assert.match(card(fixture), /datetime="2026-10-03T03:30:00.000Z"/)
  assert.match(card(fixture), /datetime="2026-10-23T00:00:00.000Z"/)
  assert.equal(JSON.parse(localStorage.getItem(key)).providers[0].metrics[0].remaining, 12)
})

test('empty settings and explicit credential failures replace cached providers instead of resurrecting them', async () => {
  const localStorage = storage()
  await prime(localStorage)
  const missing = snapshot()
  missing.providers[0] = { providerId: 'deepseek', displayName: 'DeepSeek', state: 'needs-configuration', errorCode: 'credential-missing', metrics: [] }
  await prime(localStorage, missing)
  assert.doesNotMatch(card(browserFixture({ localStorage })), /12 CNY/)
  await prime(localStorage, { generatedAt: at, providers: [] })
  assert.equal(nodes(browserFixture({ localStorage }).render(), node => node.props['data-provider'] === 'deepseek').length, 0)
})

test('session rejection clears cached usage even when a concurrent successful snapshot arrives later', async () => {
  for (const status of [401, 403]) {
    const localStorage = storage()
    await prime(localStorage)
    let finish
    const fixture = browserFixture({ localStorage, fetch: path => path.endsWith('/settings') ? Promise.resolve({ status, ok: false }) : new Promise(resolve => { finish = resolve }) })
    fixture.render(); await fixture.flushEffects()
    assert.equal(nodes(fixture.render(), node => node.props['data-provider']).length, 0)
    assert.equal(localStorage.getItem(key), null)
    finish(response(snapshot(99)))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(nodes(fixture.render(), node => node.props['data-provider']).length, 0)
    assert.equal(localStorage.getItem(key), null)
    assert.equal(fixture.rpcCalls.length, 0)
  }
})

test('cache contains only projected display data, never credential input, status or response extras', async () => {
  const localStorage = storage()
  const secret = 'fixture-private-extra'
  const value = snapshot(0)
  value.token = secret; value.providers[0].token = secret; value.providers[0].warning = secret
  value.activity = { credentialUpdatedAt: { DEEPSEEK_API_KEY: secret }, lastManualRefresh: { requestedAt: at, completedAt: at, outcome: 'complete', token: secret } }
  const fixture = browserFixture({ localStorage, fetch: async path => response(path.endsWith('/settings') ? { credentials: [{ reference: 'DEEPSEEK_API_KEY', configured: true, writable: true, token: secret }] } : value) })
  fixture.render(); await fixture.flushEffects()
  assert.ok(localStorage.getItem(key))
  assert.equal(localStorage.getItem(key).includes(secret), false)
  assert.equal(localStorage.getItem(key).includes('credentialUpdatedAt'), false)
  const reopened = browserFixture({ localStorage })
  assert.match(card(reopened), /0 CNY/)
  assert.match(htmlOf(reopened.render()), /手動刷新完成/)
})

test('OpenCode Go quota windows, zero remaining and reset timestamps survive reopening', async () => {
  const localStorage = storage()
  const body = JSON.parse(await readFile(new URL('./fixtures/opencode-go.success.json', import.meta.url), 'utf8'))
  const kinds = { rolling: 'rolling', weekly: 'calendar', monthly: 'calendar' }
  const value = { providers: [{ providerId: 'opencode-go', displayName: 'OpenCode Go', state: 'fresh', fetchedAt: at, metrics: Object.entries(body.usage).map(([name, window]) => ({ kind: 'quota', label: name === 'rolling' ? 'Rolling (5h)' : name[0].toUpperCase() + name.slice(1), unit: 'percent', used: window.percent, limit: 100, window: { kind: kinds[name], resetsAt: window.resetsAt, durationSeconds: 18000, token: 'fixture-window-extra' } })) }] }
  await prime(localStorage, value)
  const tree = browserFixture({ localStorage }).render()
  const html = htmlOf(tree)
  assert.match(html, /剩餘 57.5%/)
  assert.match(html, /剩餘 100%/)
  assert.match(html, /剩餘 0%/)
  assert.match(html, /datetime="2026-10-01T00:00:00.000Z"/)
  assert.equal(nodes(tree, node => node.type === 'progress').length, 3)
  assert.equal(localStorage.getItem(key).includes('fixture-window-extra'), false)
})

test('typing a credential never stores it locally, and a rejected save clears the usage cache', async () => {
  const localStorage = storage()
  const fixture = browserFixture({ localStorage, fetch: async path => path.endsWith('/credential') ? { status: 401, ok: false } : response(path.endsWith('/settings') ? { credentials: [{ reference: 'DEEPSEEK_API_KEY', configured: true, writable: true }] } : snapshot()) })
  fixture.render(); await fixture.flushEffects()
  nodes(fixture.render(), node => node.type === 'button' && node.children.includes('展開'))[0].props.onClick()
  const input = nodes(fixture.render(), node => node.type === 'input' && node.props['aria-label'] === 'DEEPSEEK_API_KEY')[0]
  input.props.onChange({ target: { value: 'fixture-new-private-input' } })
  assert.equal(localStorage.getItem(key).includes('fixture-new-private-input'), false)
  const row = nodes(fixture.render(), node => node.props.className === 'dsw-credential-row').find(row => nodes(row, node => node.props['aria-label'] === 'DEEPSEEK_API_KEY').length)
  nodes(row, node => node.type === 'button' && node.children.includes('儲存'))[0].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(localStorage.getItem(key), null)
  assert.equal(nodes(fixture.render(), node => node.props['data-provider']).length, 0)
  assert.match(htmlOf(fixture.render()), /瀏覽器登入已過期/)
})

test('corrupt, oversized and unavailable browser storage fall back to normal loading', async () => {
  for (const raw of ['{invalid', JSON.stringify({ version: 99, providers: snapshot().providers }), JSON.stringify({ version: 1, providers: [{ ...snapshot().providers[0], metrics: [{ kind: 'balance', remaining: null, currency: 'CNY' }] }] }), ' '.repeat(65537)]) {
    const localStorage = storage()
    localStorage.setItem(key, raw)
    const fixture = browserFixture({ localStorage, fetch: async path => response(path.endsWith('/settings') ? { credentials: [] } : snapshot()) })
    assert.equal(nodes(fixture.render(), node => node.props['data-provider']).length, 0)
    await fixture.flushEffects()
    assert.match(card(fixture), /12 CNY/)
  }
  const blocked = browserFixture({ localStorage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('quota') } }, fetch: async path => response(path.endsWith('/settings') ? { credentials: [] } : snapshot()) })
  blocked.render(); await blocked.flushEffects()
  assert.match(card(blocked), /12 CNY/)
  assert.doesNotMatch(htmlOf(blocked.render()), /網路連線失敗|用量請求失敗/)
})

test('switching UI language translates cached status without starting another refresh', async () => {
  const localStorage = storage()
  await prime(localStorage)
  let calls = 0
  const fixture = browserFixture({ localStorage, fetch: async path => { calls += 1; return response(path.endsWith('/settings') ? { credentials: [] } : snapshot()) } })
  fixture.render(); await fixture.flushEffects()
  fixture.setLocale('ja'); fixture.render(); await fixture.flushEffects()
  assert.equal(calls, 2)
})
