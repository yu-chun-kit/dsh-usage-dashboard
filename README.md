# DSH Usage Dashboard

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

An unofficial usage and credit dashboard for DeepSeek Harness (DSH), displayed in its official right sidebar.

> **Preview compatibility:** targets **DSH Preview `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.1-rc.3`** and Cordis `~4.0.4`. DSH is still a prerelease; this experimental community plugin does not promise compatibility with other previews or a future stable release. The browser UI requires the DSH 0.2 sidebar API. Older transport fallbacks do not make the UI compatible with DSH 0.1.

## Features

- Provider balance, credit and quota cards backed by shared server snapshots. Opening reuses valid data (15-minute TTL by default); missing/expired data or a manual force refresh queries providers. No background polling or billable model probes.
- Every authenticated device connected to the same DSH server/profile can read the saved snapshot without its own provider query. Expired snapshots appear before refresh completes; concurrent refreshes share one request per provider. Failed updates keep the previous numbers and original timestamps.
- Usage first, credentials in a collapsible section below; mobile layout and touch-friendly controls.
- English, Simplified Chinese, Traditional Chinese and Japanese UI, following DSH language settings with browser/English fallback.
- Fetch, attempt, credential-update and manual-refresh timestamps. A failed refresh retains the last successful snapshot and its timestamp.
- DSH Connection authentication and Host/Origin checks. Credentials are resolved and provider requests run on the DSH server.

## Provider support

| Provider | Current behavior |
| --- | --- |
| OpenRouter | Credit/usage adapter; management API key required |
| DeepSeek | Official read-only `GET /user/balance`; balance display |
| Deepgram | Balance adapter; management key, `projectId` and `balanceId` required |
| Tavily | Usage adapter; optional `projectId` |
| ChatGPT / Codex | Normalizes a server-supplied usage source; no automatic login or scraping |
| OpenCode Go | Experimental read-only usage adapter for rolling, weekly and monthly windows |
| Kilo, Serper, Brave | Experimental/unsupported; adding credentials does not enable retrieval |

Provider APIs can change independently of DSH. Offline fixtures verify adapter behavior, not a live account or endpoint.

## Install from source

Install DSH Preview `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.1-rc.3` separately. Node.js 20 or later is required. This is a GitHub source release; the package is not published to npm.

```sh
git clone https://github.com/yu-chun-kit/dsh-usage-dashboard.git
cd dsh-usage-dashboard
npm ci
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-usage-dashboard
```

Replace the final path with your clone's absolute path, and `web` with your DSH profile name. Restart that profile's DSH Web process, reload the browser and select **Usage dashboard** from the right sidebar guide. Use `dsh web --dump-config` to inspect the composed configuration before starting it.

## Credentials and privacy

Use DSH credential management, or the authenticated dashboard when its credential store is writable. Never put credentials into `cordis.patch.yml`, source files, Git, screenshots, issue reports or command-line arguments.

| Reference | Provider |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `DEEPGRAM_API_KEY` | Deepgram |
| `TAVILY_API_KEY` | Tavily |
| `OPENCODE_GO_API_KEY` | OpenCode Go |

Known DSH Models API-key records for OpenRouter, DeepSeek and OpenCode Go can also be reused on the server. Explicit references take priority. OAuth grants and arbitrary records are not interpreted.

Settings return reference names, boolean configuration/write status, known source labels and timestamps. Secret values and partial key previews are never returned. Password inputs clear after a successful save. Writes accept only declared references and 8–4096 characters without line breaks.

Shared last-good snapshots are persisted in the DSH `dsh-usage-dashboard/snapshots` record through the host's atomic record API. A versioned, validated display-field projection is limited to 64 KiB and tied to normalized settings. Data timestamps and expiry survive restart; credential/settings changes invalidate it. No credentials, form inputs or raw responses/warnings are stored in this snapshot. Hosts without the record API retain shared in-memory caching only; a failed store does not break usage display.

Opening first reads the authenticated server snapshot with `{ cacheOnly: true }` on the existing snapshot endpoint, which never queries providers or waits for an in-flight refresh. A `needsRefresh` result triggers a normal refresh while displaying saved data. Valid snapshots require no provider request, including on a new device or after a server restart. Devices sharing one running service share provider requests; separate DSH servers do not share this cache. Existing pages update on opening/remount or manual refresh, not by polling or cross-device push.

Each browser also stores a bounded, versioned display copy in same-origin `localStorage` for immediate display before the server responds. It contains provider identifiers, numbers, labels, timestamps and manual-refresh outcome, excluding credentials, form inputs and credential status. The server response is authoritative and replaces this copy. Network failures retain the local display; provider failures retain server last-good data. Removed providers and explicit credential/setup failures replace old data. A 401/403 clears the browser copy. Corrupt/unavailable storage falls back to normal loading. Clear this site's browser data to remove the local copy; anyone using that browser profile can read it.

The DSH `dsh-usage-dashboard/activity` record stores only allowed reference names, timestamps and refresh outcomes, with no keys or provider snapshots. Without the record API, server activity stays in memory and disappears on restart. Earlier events, external environment changes and original session issuance dates cannot be reconstructed.

Public errors use fixed messages. Logs exclude credentials, provider response bodies and raw exception text. A best-effort `dsh-usage-dashboard-boot.log` in the operating system's temporary directory records route names and registration outcomes only; it can be deleted.

Authenticated users can see account usage and balances; treat those numbers as private when sharing screenshots. Repository fixtures contain synthetic data. Credentials, environment files, logs and local development notes are excluded from the public source snapshot. Ignore rules alone cannot remove files already committed to Git history.

## Transport and boundaries

Exact routes under `/api/usage-dashboard/{snapshot,settings,settings-write,credential}` reuse Connection's browser-session and trusted-host fence. Without Connection, the route helper permits only loopback requests. Activation waits for `webServer`, `connection` and `credentials`. Mobile and desktop use the same authenticated, same-origin API.

The legacy `/usage-dashboard` RPC remains only for older Connection adapters without the modern fence. DSH 0.2 uses authenticated exact routes. The plugin does not alter the Harness agent loop or grant command/workspace permissions.

## Development and verification

```sh
npm ci
npm test
npm run check
```

Tests use fake credentials and offline provider/browser fixtures. No real key, model request or external MCP server is needed. An optional installed-DSH contract check is skipped unless a module root is supplied:

```sh
DSH_TEST_MODULE_ROOT=/absolute/path/to/dsh/node_modules node --test test/dsh-contract.test.mjs
```

It uses installed services with fixture credentials and forbids provider traffic; it does not load a live profile. Compatibility targets the locally verified `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.1-rc.3` installation, not a future release.

Edit `locales/{en,zh-Hans,zh-Hant,ja}.json` and `src/client/i18n.ts`, then build. The build validates keys/parameters and synchronizes generated dictionaries and browser localization code. Do not edit generated localization sections directly. Other DSH UI translations belong to their own language packs.

## License

[MIT](LICENSE). This community project is not an official DeepSeek release.

For DSH 0.2.1, the slots core is compiled into the browser distribution. To run the host-side SlotCore acceptance test, supply `DSH_TEST_SLOTS_ROOT=/absolute/path/to/an/extracted/@deepseek-ai/dsh-client-ui-slots@0.2.1-rc.2` together with `DSH_TEST_MODULE_ROOT`. Keep that exact official package in an isolated test directory; do not insert it into the running CLI.
