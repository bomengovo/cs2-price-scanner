# CSQAQ Liquidity Stage B0.1 Revalidation Report

Date: 2026-08-17 (Asia/Shanghai)  
Scope: read-only research only; production scanner and data were not changed.

## 1. Executive summary

**STAGE B0.1 = RANK_MAPPING_ONLY.**

`get_popular_goods` remains unavailable to the current Token after IP binding recovery: the one permitted request returned HTTP 401 / business `code: 401`. This is now valid current evidence that the Token is not authorized for that endpoint.

The Route B fallback succeeded: a 20-row `get_rank_list` page and a 20-row `get_good_id` page produced a strict 20/20 `id` join, 20/20 identical Chinese names, and 20/20 complete Steam `market_hash_name` values. Therefore, for the returned page, `rank_list.id == CSQAQ good_id` is **CONFIRMED**.

Execution note: the first Route B script sent the permitted one-page rank and one-page good-id requests successfully but then closed its read-only SQLite handle before formatting output. It was corrected and the same bounded page pair was repeated once to produce auditable results. Thus the actual Route B ledger is two same-page rank calls and two same-page good-id calls; no additional page, no row count above 20, and no retry loop was used.

This confirms a safe mapping route for future research, but does **not** prove the semantic period of `statistic`, the semantics of `rank_num`, or the freshness meaning of `created_at`. No field is being connected to production, Stage A, ranking, UI, or an Opportunity Score in this phase.

## 2. Auth recovery context

The current app's CSQAQ startup bind completed successfully before this research, and the existing real batch-price chain is known to return HTTP 200 / `code: 200`. This study did not bind an IP, change a Token, alter headers for privilege escalation, or use browser credentials.

All calls used the configured Token only in process memory. Output was limited to `CSQAQ_API_TOKEN = CONFIGURED`; no Token value is stored in this report, scripts, JSON, or logs.

## 3. `get_popular_goods` result

| Endpoint | Requests | HTTP | API code | Result |
| --- | ---: | ---: | ---: | --- |
| `POST /api/v1/info/get_popular_goods` | 1 | 401 | 401 | `CURRENT_TOKEN_NOT_AUTHORIZED_FOR_POPULAR_GOODS` |

The response message was the endpoint's Chinese invalid-address/authorization rejection. Per the stop rule, no retry, URL guessing, alternate header, Cookie, browser session, or further popular-goods request was made.

Consequently, no current `get_popular_goods` schema, turnover field, rank field, or scanner exact-match analysis exists. The earlier 401 conclusion has now been re-tested after IP recovery and is upheld specifically for this endpoint's authorization.

## 4. Route B: response schema and mapping test

The public/open API documentation for `get_good_id` defines a paged POST response containing `id`, `name`, and `market_hash_name`; this was verified against the current live response. [CSQAQ open API documentation](https://s.apifox.cn/apidoc/docs-site/4711104/api-187131777)

| Request | Payload limit | HTTP / code | Returned | Purpose |
| --- | ---: | --- | ---: | --- |
| `POST /api/v1/info/get_rank_list` | page 1, 20 | 200 / 200 | 20 | same single candidate page; invoked twice because first local output failed |
| `POST /api/v1/info/get_good_id` | page 1, 20 | 200 / 200 | 20 | same single mapping page; invoked twice because first local output failed |

`get_rank_list` fields observed: `id`, `name`, `rank_num`, `statistic`, `buff_sell_num`, `yyyp_sell_num`, `buff_buy_num`, `yyyp_buy_num`, and `created_at`.

`get_good_id` fields observed: `id`, `name`, and `market_hash_name`.

## 5. `market_hash_name` validation

| Check | Result |
| --- | ---: |
| Rank rows inspected | 20 |
| Strict `rank.id === good.id` joins | 20 / 20 |
| Joined Chinese `name` exact equality | 20 / 20 |
| Non-empty `market_hash_name` | 20 / 20 |
| Scanner exact `market_hash_name` matches | 3 / 20 |

Examples of proof, using exact ID + exact Chinese name rather than translation or fuzzy matching:

| rank id / good id | Chinese name | Strict Steam `market_hash_name` |
| ---: | --- | --- |
| 1 | 运动手套（★）\|迈阿密风云（略有磨损） | `★ Sport Gloves | Vice (Minimal Wear)` |
| 4 | M4A4 \| 杀意大名（久经沙场） | `M4A4 | Evil Daimyo (Field-Tested)` |
| 10 | 幻彩 3 号武器箱 | `Chroma 3 Case` |
| 14 | MAC-10 \| 银质（崭新出厂） | `MAC-10 | Silver (Factory New)` |
| 20 | 格洛克 18 型 \| 本生灯（久经沙场） | `Glock-18 | Bunsen Burner (Field-Tested)` |

The returned page covers weapon skins, cases, stickers, and ★ gloves; exact market names preserve wear and the ★ marker. No StatTrak™ or Souvenir sample occurred in this single page, so this experiment does not claim their page-level coverage; the mapping contract itself preserves their `market_hash_name` strings when returned.

## 6. `turnover_number` validation

`get_popular_goods`: not observable because it is unauthorized.  
`get_rank_list`: `turnover_number` and `volume` were **not returned**.

Thus there is no new current endpoint value that can be compared to Stage A's `turnover_number`; the Stage A field remains independent historical data. The rank response's `statistic` is not renamed or treated as turnover.

## 7. Freshness

All 20 current rank rows returned `created_at = 2026-08-17T16:13:49`.

This is a server-provided timestamp value on the test date, but the response does not provide `updated_at`, `period_at`, `timestamp`, explicit timezone, or documentation proving that `created_at` is the liquidity snapshot refresh time. The result is therefore:

```text
API availability: YES
Data freshness: UNKNOWN
Raw created_at: 2026-08-17T16:13:49
```

No conclusion is based on workstation time.

## 8. Period semantics

`turnover_number` is unavailable in the current authorized Route B response. No `period`, `period_at`, `time_window`, or `days` field was returned.

```text
turnover_number field confirmed: NO (Route B)
turnover period: UNKNOWN
```

It must not be called 24-hour, daily, weekly, monthly, or cumulative turnover.

## 9. `rank_num` and `statistic` analysis

For 20 rank rows: `rank_num` min 229, median 1064, p90 9228, max 15124; all 20 values were unique and none was 1. `rank_num_change` was not returned.

`statistic` had 20 numeric values: min 0, median 70,582, p90 1,308,652, max 2,921,771; 6 values were zero. Requested-order `statistic` versus `rank_num` Spearman correlation was `0.017525`, effectively no monotonic relation in this sample.

Three of the 20 exact mapped items also existed in the current scanner. Their `statistic` and old Stage A turnover happened to have very high correlation (Pearson 0.999858, Spearman 1.0), but `n=3` is not semantic proof and there is no period evidence. The only valid conclusion is:

```text
rank_num: CANDIDATE ranking field, NOT YET usable for Opportunity Score
statistic: UNKNOWN semantics, DO_NOT_USE as turnover
```

## 10. Stage A comparison

| Exact scanner item | Stage A turnover | Stage A period_at | Route B statistic | Difference / ratio |
| --- | ---: | --- | ---: | --- |
| M4A4 \| Evil Daimyo (FT) | 196 | historical Stage A metadata | 233,066 | different magnitude; period unknown |
| MAC-10 \| Silver (FN) | 1,265 | historical Stage A metadata | 2,238,544 | different magnitude; period unknown |
| Glock-18 \| Bunsen Burner (FT) | 223 | historical Stage A metadata | 321,419 | different magnitude; period unknown |

The magnitudes differ sharply, which may indicate a different metric or period. It does not establish which. Route B cannot prove that it is newer than Stage A.

| Question | Answer |
| --- | --- |
| Can a new `turnover_number` join scanner rows by `market_hash_name`? | No new `turnover_number` was returned; mapping route is YES. |
| Does a new verified turnover value differ from Stage A? | UNKNOWN. |
| Is it confirmed newer than Stage A? | UNKNOWN. |
| Statistics period | UNKNOWN. |
| Can `rank_num` feed Opportunity Score now? | NOT YET. |

## 11. Rank/good-id fallback test

The current 20/20 exact ID and name evidence confirms `rank_list.id == get_good_id.id` for the tested page. This resolves the prior Stage B0 mapping gap without relying on Chinese-to-English conversion or numeric coincidence alone.

It does not prove that all pages, all time, or all future API versions preserve the contract. A future production integration must retain the triple validation (rank id, good id, name) during any initial rollout.

## 12. Inventory comparison

Only three mapped rank items were present in the current scanner results.

| Item | Rank BUFF sell / Scanner | Rank YYYP sell / Scanner | Rank BUFF buy / Scanner | Rank YYYP buy / Scanner |
| --- | --- | --- | --- | --- |
| M4A4 Evil Daimyo FT | 656 / 656 | 376 / 379 | 26 / 0 | 6 / 0 |
| MAC-10 Silver FN | 4354 / 4358 | 2487 / 2485 | 833 / 0 | 17 / 0 |
| Glock-18 Bunsen Burner FT | 307 / 307 | 96 / 96 | 39 / 0 | 11 / 0 |

Sell-side exact rate: BUFF 2/3, YYYP 1/3; median absolute difference: BUFF 0, YYYP 2. Buy-side values differ because current scanner batch data carries zero bids for these rows. These are candidates for future liquidity features, not verified current truth or scoring inputs.

## 13. Risks

- Popular-goods authorization is absent for the current Token.
- Rank list has no returned `market_hash_name`; mapping requires a separate good-id dataset.
- `statistic` and `rank_num` lack proven semantics and period.
- `created_at` is observed but is not a confirmed update/snapshot timestamp.
- The current exact scanner overlap is only three rows; inventory observation is too small for freshness guarantees.

## 14. Final Stage B0.1 status

```text
STAGE B0.1 = RANK_MAPPING_ONLY
```

This status is stronger than the old `BLOCKED` result: a reliable strict ID-to-market-hash mapping now exists. It is deliberately weaker than PASS/PARTIAL because there is still no authorized, semantically verified current turnover metric.

## 15. Stage B1 recommendation (schema only; do not migrate yet)

| Proposed field | Status | Use in B1 |
| --- | --- | --- |
| `liquidity_turnover` | DO_NOT_USE | no verified current turnover value |
| `liquidity_turnover_source` | UNKNOWN | only after a verified metric exists |
| `liquidity_turnover_period` | UNKNOWN | no period evidence |
| `liquidity_turnover_fetched_at` | CANDIDATE | capture raw API fetch time separately from source period |
| `buff_sell_count` | CANDIDATE | preserve as independent rank snapshot value |
| `youpin_sell_count` | CANDIDATE | preserve as independent rank snapshot value |
| `buff_buy_count` | CANDIDATE | preserve as independent rank snapshot value |
| `youpin_buy_count` | CANDIDATE | preserve as independent rank snapshot value |
| `liquidity_rank` | CANDIDATE | retain raw `rank_num`, no score/default sorting |
| `liquidity_rank_change` | UNKNOWN | not returned in current response |

The next phase should first implement a read-only or isolated-cache validation job that refreshes the rank/good-id mapping, measures timestamp behavior over multiple authorized snapshots, and validates the meaning of `statistic` through official documentation or a named response field. Do not implement Opportunity Score, recommendation labels, default sort changes, or production database migration until those facts are confirmed.

## Safeguard ledger

```text
SQLite writes: 0
CSFloat calls: 0
SteamDT calls: 0
Browser automation: 0
Popular-goods calls: 1 (no retry)
Route B rank page calls: 2 (both page 1, 20 rows; no pagination)
Route B good-id page calls: 2 (both page 1, 20 rows; no pagination)
```
