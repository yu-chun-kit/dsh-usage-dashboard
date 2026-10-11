import assert from 'node:assert/strict'
import test from 'node:test'
import { browserFixture, nodes, htmlOf } from './helpers/browser-fixture.mjs'

test('official sidebar guide opens the dashboard and unloading releases both keyed seats',()=>{
  const fixture=browserFixture()
  assert.equal(fixture.definition().id,'dsh-usage-dashboard')
  assert.equal(fixture.definition().kind,'dsh-usage-dashboard')
  assert.equal(fixture.definition().guide[0].title(),fixture.title())
  assert.equal(fixture.registrations.length,3)
  assert.match(htmlOf(fixture.render()),/data-dsh-usage-tab/)
  fixture.dispose()
  assert.equal(fixture.registrations.length,0)
})

test('the browser manual refresh records a manual reason and displays returned server times', async () => {
  const calls = []
  const at = '2026-10-03T03:30:00.000Z'
  const fixture = browserFixture({ fetch: async (path, options) => {
    calls.push({ path, payload: JSON.parse(options.body), credentials: options.credentials })
    return { status: 200, ok: true, json: async () => ({ ok: true, value: path.endsWith('/settings') ? { credentials: [] } : { providers: [{ providerId: 'deepseek', displayName: 'DeepSeek', state: 'fresh', fetchedAt: at, attemptedAt: at, metrics: [{ kind: 'balance', remaining: 12, currency: 'CNY' }] }], activity: calls.at(-1).payload.reason === 'manual' ? { lastManualRefresh: { requestedAt: at, completedAt: at, outcome: 'complete' } } : {} } }) }
  } })
  fixture.render(); await fixture.flushEffects()
  const tree = fixture.render()
  const refresh = nodes(tree, node => node.type === 'button' && node.children.includes('重新整理'))[0]
  refresh.props.onClick(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.find(call => call.payload.reason === 'manual').payload.force, true)
  assert.ok(calls.every(call => call.credentials === 'same-origin'))
  const html = htmlOf(fixture.render())
  assert.match(html, /手動刷新發起/)
  assert.match(html, /手動刷新完成/)
  assert.match(html, /datetime="2026-10-03T03:30:00.000Z"/)
  assert.equal(fixture.rpcCalls.length, 0)
})

test('expired mobile sessions display a sign-in message without bypassing authentication', async () => {
  const fixture = browserFixture({ fetch: async () => ({ status: 401, ok: false }) })
  fixture.render(); await fixture.flushEffects()
  assert.match(htmlOf(fixture.render()), /瀏覽器登入已過期/)
  assert.equal(fixture.rpcCalls.length, 0)
})

test('missing credentials are presented as setup and timestamps remain unknown until recorded', () => {
  const fixture = browserFixture({ states: [{ loading: false, providers: [{ providerId: 'deepseek', displayName: 'DeepSeek', state: 'needs-configuration', errorCode: 'credential-missing', metrics: [] }], activity: {} }, { loading: false, items: [] }] })
  const tree = fixture.render()
  const card = nodes(tree, node => node.props['data-provider'] === 'deepseek')[0]
  assert.match(htmlOf(card), /需要設定/)
  assert.match(htmlOf(card), /未記錄/)
  assert.doesNotMatch(htmlOf(card), /dsw-provider-status--error/)
  nodes(card, node => node.type === 'button')[0].props.onClick()
  assert.match(htmlOf(fixture.render()), /type="password"/)
})
