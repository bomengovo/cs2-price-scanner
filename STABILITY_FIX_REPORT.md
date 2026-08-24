# CS2 Price Scanner Stability Fix Report

Date: 2026-08-17 (Asia/Shanghai)

## Backup and scope

- Backup created before changes: `data/backups/stability-fix-20260817-1602/`.
- It includes the SQLite database (and WAL/SHM sidecars), `.env.local`, and all modified core source files.
- No API token was changed, printed, removed, or copied. No proxy, VPN, firewall, system network setting, database reset, or result deletion was performed.

## Root causes corrected

1. A CSQAQ `401/403` was treated as an ordinary per-item failure. The low-priority turnover queue could continue to request every remaining item.
2. CSQAQ IP binding was only a manual diagnostic operation; it was not part of the application lifecycle or request recovery path.
3. CSFloat used a fixed 60-second cooldown. Its health state did not persist a consecutive-failure backoff or clearly distinguish snapshot data.
4. `scan_results` only replaced a row when a newly discovered CSFloat listing was cheaper. Fresh domestic-market prices for a retained listing could therefore be discarded.
5. The dashboard inferred the domestic provider by inspecting historical result rows, which could incorrectly label an old source as the current scan source.

## Implemented changes

### CSQAQ

- Added `src/lib/csqaq-ip-binding.ts`.
  - Server-side only `bind_local_ip` request using the existing secret accessor.
  - Single-flight binding/rebinding, 10-minute minimum bind cooldown, no token logging.
  - Startup preflight is non-blocking and enabled unless `CSQAQ_AUTO_BIND_IP=false`.
  - A `401/403` performs one shared rebind and retries the original operation exactly once.
  - If retry still fails, state becomes `CSQAQ_AUTH_ERROR`; queued CSQAQ work is rejected without another external request.
- Added durable provider state in SQLite (`provider_state`).
- Batch prices and `/info/good` both use the recovery wrapper.
- Turnover enrichment now stops immediately with `auth_error` instead of continuing a failure storm.
- Added non-sensitive structured bind/recovery entries to `logs/provider-api.log`.

### CSFloat

- Extended the global listings circuit breaker with persisted exponential cooldowns: 60s, 120s, 300s, 600s (unless the provider supplies `Retry-After`).
- While the circuit is active, scheduler requests are rejected locally; no additional CSFloat request is made.
- Health/rate APIs now expose `CSFLOAT_LIVE`, `CSFLOAT_RATE_LIMITED`, `CSFLOAT_SNAPSHOT`, or `CSFLOAT_UNAVAILABLE`, retry timestamp, snapshot timestamp, and failure count.
- The scan path falls back directly to the last SQLite snapshot after the single failed request.

### Persistence, source truth, and UI

- Schema migration 6 adds `provider_state` and `scan_sessions.provider_json`; it is additive and preserves existing data.
- Result merging remains keyed by `marketHashName`, but listing selection and domestic-price freshness are now independent. New BUFF/悠悠 data can update a retained CSFloat listing.
- Each scan session stores actual domestic source, CSFloat live/snapshot source, CSFloat data time, domestic data time, and save time.
- The dashboard reads the session source rather than inferring it from historical rows. Row status tooltips show separate CSFloat and domestic data timestamps; turnover continues to show its own source/fetched/statistical date.

## Files changed

- `src/lib/csqaq-ip-binding.ts` (new)
- `src/lib/csqaq.ts`
- `src/lib/rate-limit/csqaq-scheduler.ts`
- `src/lib/turnover-enrichment.ts`
- `src/lib/rate-limit/csfloat-scheduler.ts`
- `src/lib/db.ts`
- `src/lib/scanner.ts`
- `src/app/api/health/route.ts`
- `src/app/api/rate-status/route.ts`
- `src/components/scanner-dashboard.tsx`
- `.env.example`
- `tsconfig.json`
- `tests/integration.test.ts`

## Validation

- `npm.cmd test -- --run --silent`: passed, 38 tests.
- `npm.cmd run lint`: passed.
- `npm.cmd run build`: passed.
- Production service restarted through the project launcher and health-checked on `http://127.0.0.1:3000`.
- Health result after restart: schema 6, CSQAQ `CSQAQ_LIVE`, saved results retained (615).
- Final real 10-listing forced scan:
  - HTTP 200 and result stream completed.
  - CSQAQ: 1 real batch request, 8 matched items, `CSQAQ_LIVE`.
  - SteamDT fallback: 0 requests.
  - CSFloat: received the provider's `429 Too Many Requests` response, made no retry, entered 120-second circuit cooldown, and completed with the persisted Snapshot.

## Current external status

- CSQAQ: `CSQAQ_LIVE`; the startup IP binding succeeded in approximately 1.1 seconds.
- CSFloat: `CSFLOAT_RATE_LIMITED` / external block. The provider response says requests are coming from too many IPs. This is an upstream access restriction, not a local token validity result. The application now treats it as `EXTERNAL_BLOCKED` operationally: it avoids repeat requests during cooldown and continues safely from Snapshot plus CSQAQ domestic data.

## Remaining operational note

No further local retry, key, proxy, or network change is required for CSFloat safety. When the provider's cooldown expires, the next user-initiated scan will make at most one normal probe; a successful response resets the breaker, while another 429 advances the persisted backoff.
