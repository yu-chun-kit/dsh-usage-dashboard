import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, createUsageDashboardService, publicError, redactSecret, UsageDashboardError } from '../lib/index.js'
import { readFile } from 'node:fs/promises'
import { BOOT_DIAGNOSTIC_FILE } from '../lib/host/index.js'

test('public diagnostics and masks never expose any part of an opaque credential', () => {
  for (const secret of ['fixture-opaque', 'fixture/opaque/value', 'fixture@opaque']) {
    assert.equal(redactSecret(secret), '••••')
    assert.equal(publicError(new UsageDashboardError('provider-http', secret)).message, 'The provider returned an HTTP error.')
  }
})

test('credential status projects booleans and known source labels only', async () => {
  const secret = 'fixture-opaque'
  const service = createUsageDashboardService({
    credentials: { resolve: async () => secret },
    credentialStatus: async () => ({ configured: secret, writable: secret, source: secret, value: secret, token: secret }),
    settings: { enabledProviders: [] },
    fetcher: async () => { throw new Error('No provider traffic allowed') },
  })
  const status = await service.handle('settings/read', {})
  assert.equal(status.ok, true)
  assert.equal(JSON.stringify(status).includes(secret), false)
  assert.ok(status.value.credentials.every(row => row.configured === false && row.writable === false && row.source === undefined))
})

test('registration failures never put exception text in the boot diagnostic', async () => {
  const secret = 'fixture-boot-private-value'
  apply({
    webServer: { register() { throw new Error(secret) } },
    connection: { rpc: { handle() { throw new Error(secret) } } },
    credentials: { resolve: async () => undefined },
  }, { enabledProviders: [] })
  // Diagnostic writes are best effort; importing fs and writing may be deferred.
  await new Promise(resolve => setTimeout(resolve, 30))
  const diagnostic = await readFile(BOOT_DIAGNOSTIC_FILE, 'utf8')
  assert.match(diagnostic, /route-failed:/)
  assert.equal(diagnostic.includes(secret), false)
})
