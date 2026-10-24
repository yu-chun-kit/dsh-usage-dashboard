# Changelog

## 0.1.1 — 2026-10-24

- Declare the reviewed DSH Preview versions in `engines.dsh`, including `0.2.1-rc.3`, and check their real module contracts in CI.
- Persist shared last-good usage snapshots through DSH's record API, retaining timestamps and expiry across server restarts.
- Show the server's saved snapshot before refreshing; reuse valid data across devices and coalesce concurrent provider requests.
- Keep a browser display copy for immediate rendering, with the authenticated server response as the authority.
- Invalidate saved data on credential/settings changes and clear local usage after authentication rejection.
- Avoid provider refreshes when only the interface language changes.

## 0.1.0 — 2026-10-12

- Initial public preview for DSH `0.2.0-rc.2`, published from an audited source snapshot.
