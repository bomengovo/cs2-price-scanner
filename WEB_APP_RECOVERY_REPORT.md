# CS2 Price Scanner Web Recovery Report

Date: 2026-08-17 (Asia/Shanghai)

## Scope and backup

- Existing project repaired in place; no project, database, Token, or API configuration was recreated, printed, or reset.
- Backup created before changes: `data/backups/web-recovery-20260817-1634/`.
- Backup includes the pre-change `scanner.db`, SQLite WAL/SHM files when present, and `.env.local`.
- Pre-change database: 615 active results, 0 soft-deleted results, 0 duplicate `marketHashName` values.
- Post-change database: 615 active results, 0 soft-deleted results, 0 duplicate `marketHashName` values.

## Repairs completed

1. **CSFloat 429 / Snapshot path**
   - The UI no longer disables scanning during a CSFloat cooldown. It explicitly offers Snapshot scanning instead.
   - A real 429 opens the persisted cooldown circuit and does not generate retry loops. The next scan uses the latest saved listing Snapshot when available.
   - The scan-session record now persists the actual source (`LIVE`, `SNAPSHOT`, `RATE_LIMITED`, `ERROR`, or `MOCK`) and its timestamp.

2. **CSQAQ binding and 401 recovery**
   - Startup IP-binding preflight is process-singleton, so health checks cannot repeatedly trigger binding.
   - A 401/403 follows exactly one recovery sequence: bind once, retry the original request once, then open an authorization circuit if the retry still fails.
   - Mock scans are now fully offline and never start a real IP-binding request.

3. **Domestic-price refresh correctness**
   - Updating BUFF/悠悠有品 prices now recalculates profit, profit rate, best platform, and dual-low status from the merged fresh values.
   - This removes the stale-profit case where a domestic price was updated but the displayed comparison remained old.
   - Refreshing saved prices uses the domestic provider only; it does not invoke CSFloat listing discovery.

4. **Persistent UI state**
   - Reloaded pages restore the last persisted session rather than infer provider state from old rows.
   - The page independently shows CSFloat and domestic sources plus their respective fetch times.
   - Existing item images and CSFloat / BUFF / 悠悠有品 links remain intact.

## Verification evidence

| Check | Result |
| --- | --- |
| `npm.cmd install` | Passed; existing dependency tree retained |
| `npm.cmd test` | Passed: 41 / 41 |
| `npm.cmd run lint` | Passed |
| `npm.cmd run build` | Passed |
| Production startup | Passed with `/api/health` status `ok` |
| Real small scan | 10 listings, CSFloat `SNAPSHOT`, CSQAQ `LIVE`, 1 CSQAQ batch, 8 matches |
| Real 100-listing scan | 100 listings, 39 unique names, 38 matches, CSFloat `SNAPSHOT`, CSQAQ `LIVE`, no SteamDT fallback |
| Saved-price refresh | 100 requested, 94 updated, CSQAQ 2 batches, no SteamDT fallback |
| CSFloat isolation during refresh | CSFloat `lastRequestAt` unchanged before/after refresh |
| Browser page | Loaded successfully; no console warnings/errors; Snapshot and CSQAQ timestamps visible |
| Browser reload and app restart | 615 results and latest 100-listing session retained |
| Production rank/popular paths | No `get_popular_goods`, rank, or popular endpoint reference found under `src/` |

## Current runtime state

- Local address: `http://127.0.0.1:3000/`
- Production PID at final verification: `40224`
- Health: database `ok`, schema version `6`, saved results `615`
- CSQAQ: `CSQAQ_LIVE`
- CSFloat: the upstream service returned a real rate limit during verification. The persisted circuit is active and the application is correctly serving the saved Snapshot without retrying. Once the provider cooldown expires, the next scan will attempt one normal live request again.

## Remaining external limitation

CSFloat controls its own upstream quota. A local application cannot make a provider 429 disappear safely; the implemented behavior is to preserve the current history, avoid repeated requests, surface the cooldown honestly, and keep the scanner usable through its latest saved Snapshot and CSQAQ domestic-price updates.

## Original problems and root causes

| Original issue | Root cause | Resolution |
| --- | --- | --- |
| CSFloat 429 made scanning appear unavailable | UI disabled the normal scan control during the provider cooldown | Cooldown now selects the persisted Snapshot path and labels it truthfully |
| Provider badge could be misleading after reload | UI inferred the source from historical rows instead of the latest scan | A durable `ScanSessionState` is saved and read as the sole source of the summary badge |
| Domestic updates could leave stale profit values | The merge retained selected listing fields without recalculating the comparison | Merge recomputes the shared pricing calculation after fresh domestic values are applied |
| Background CSQAQ recovery risked repeated calls | Binding preflight could run more than once per process and recovery needed an explicit circuit | One process preflight, one bind/retry recovery, then `AUTH_ERROR` circuit |
| Mock tests could touch real binding behavior | Preflight was started before confirming mock mode | Mock scans are offline before any provider preflight is scheduled |

## Modified files

| File | Change |
| --- | --- |
| `src/lib/types.ts` | Added the persisted, provider-accurate scan session shape. |
| `src/lib/scanner.ts` | Saves session source/time metadata; isolates mock mode from real CSQAQ binding. |
| `src/lib/csqaq-ip-binding.ts` | Adds process-singleton startup binding and bounded 401/403 recovery. |
| `src/lib/db.ts` | Recalculates comparisons after independent domestic price updates. |
| `src/components/scanner-dashboard.tsx` | Renders persisted CSFloat/domestic source and timestamps; keeps Snapshot scan available during cooldown. |
| `tests/integration.test.ts` | Covers 401 recovery/circuit behavior and fresh domestic-price merge behavior. |

## Revalidation run (16:46–16:50 Asia/Shanghai)

- Additional pre-run backup: `data/backups/web-recovery-recheck-20260817-1646/`.
- Database before and after: **615 active / 0 soft-deleted / 0 duplicate names**.
- `npm.cmd install`, `npm.cmd run lint`, `npm.cmd test`, and `npm.cmd run build`: all passed; tests are **41 / 41**.
- Production server restarted successfully; final health endpoint reports application/database `ok`, CSQAQ `CSQAQ_LIVE`, and CSFloat `CSFLOAT_RATE_LIMITED` with a valid local cooldown.
- Real 10-listing scan: CSFloat Snapshot, CSQAQ Live, 1 domestic batch, 8 matches, 0 CSFloat network calls while cooling down.
- Real 100-listing scan: 39 unique names, 38 domestic matches, CSQAQ Live, no SteamDT fallback, 39 domestic updates.
- Saved domestic-price refresh: 94 rows updated in 2 CSQAQ batches, 0 CSFloat calls, 0 SteamDT fallback calls.
- Browser verification: no console errors; F5 and a production service restart restore 615 results, Snapshot time, CSQAQ Live time, valid image URLs, and CSFloat/BUFF/悠悠 HTTPS links.
- Turnover state remains cache/history based: 607 results with existing daily-volume data; no enrichment failure blocked scanning or erased values.
