# CSQAQ 日成交量（Stage A）验收报告

## 结论

**Stage A：PASS。** 扫描器现在将 CSQAQ `/api/v1/info/good?id={good_id}` 返回的商品级 `turnover_number` 持久化为 **CSQAQ 日成交量**。它不再把 BUFF 或悠悠有品的在售数量、错误平台成交量或未知值当作该指标。

`turnover_number` 的语义判定为 **CONFIRMED**：先以 12 个真实样本覆盖枪械、贴纸、刀/手套、探员，逐项确认 HTTP 200、业务 `code: 200`、商品名完全一致；后续以 10 条当前数据库商品进行 API、SQLite 和网页的逐项交叉验证，10/10 一致。

CSQAQ 返回的 `period_at` 在本次验收中是 2025-10 至 2025-11 的统计日，而非当前上海日期。因此网页展示数值和统计日，并以 `CSQAQ · STALE` 明确提示源统计日过期；它绝不把历史日数据标成“今天”。本次没有可直接用于对比的 CSQAQ 公共商品页 DOM；语义证据采用真实 API 的名称/字段一致性以及先前确认的前端字段映射，未使用 `/info/chart`。

## 实现范围

- SQLite schema version 升至 5：`csqaq_item_metadata` 新增 `turnover_number`、`turnover_avg_price`、`period_at`，并增加 `turnover_enrichment_state` 记录后台任务状态。
- `getCSQAQItemMetadata` 以商品 `good_id` 调用 `/info/good`，6 小时 TTL、同一 good_id single-flight、全局 CSQAQ 调度器、低优先级队列、429 冷却后继续。
- 新增 `/api/turnover`，页面先补当前页，再低优先级补全全部缺失/过期商品；扫描主链路不等待成交量请求。
- 新列为独立的“日成交量”，支持最低成交量筛选、升/降序，未知值固定排到末尾，真实 `0` 保留并展示为 `0`。
- 旧 `/info/chart` 路径已从成交量实现中移除；旧平台成交量接口保留为不发请求的不可用兼容响应，UI 不再调用它。

## 全库回填与限流结果

| 项目 | 结果 |
| --- | ---: |
| 已保存商品 | 581 |
| 可查询 CSQAQ `good_id` | 573 |
| 已持久化成交量 | 573 |
| 真实 `0` | 88 |
| 可查询但未知 | 0 |
| 首轮回填 | 447 项（445 成功，2 个临时失败） |
| 补偿回填 | 63 项，63 成功 |
| 扫描后新增补全 | 65 项，65 成功 |
| 后台 `/info/good` 调度请求 | 575 |
| 后台成功写入 | 573 |
| 429 | 0 |
| 后台首次临时失败 | 2，均已在补偿回填成功 |

调度最低间隔为 1.1 秒；所有工作均由同一 CSQAQ 调度队列执行。连续刷新页面 20 次前后，`csqaq-enrichment.log` 的 `INFO_GOOD` 事件均为 575，证明新鲜缓存没有重复请求上游。

## 10 条 API -> SQLite -> 网页一致性样本

网页在“最低日成交量 = 100、日成交量最高”下显示以下前十行；`网页值` 与 API、SQLite 完全一致。网页日期为 Shanghai 本地显示的 `period_at`。

| 商品 | good_id | API/SQLite/网页值 | period_at | 网页状态 |
| --- | ---: | ---: | --- | --- |
| Dreams & Nightmares Case | 14675 | 148808 | 2025-11-06 | STALE |
| Kilowatt Case | 19521 | 108793 | 2025-10-30 | STALE |
| Recoil Case | 15447 | 105312 | 2025-10-28 | STALE |
| Sealed Genesis Terminal | 23870 | 63836 | 2025-11-27 | STALE |
| Sticker \| Grayhound Gaming \| Paris 2023 | 16564 | 5956 | 2025-10-30 | STALE |
| Sticker \| BLAST.tv \| Paris 2023 | 16563 | 4928 | 2025-11-17 | STALE |
| Sticker \| Team Liquid \| Paris 2023 | 16560 | 3303 | 2025-11-07 | STALE |
| Sticker \| BLAST.tv \| Austin 2025 | 23031 | 3280 | 2025-11-22 | STALE |
| Sticker \| The MongolZ \| Paris 2023 | 16561 | 3208 | 2025-11-05 | STALE |
| Charm \| Lil' SAS | 20759 | 2734 | 2025-10-24 | STALE |

为避免泄露密钥，所有日志与报告只记录 `CSQAQ_API_TOKEN = CONFIGURED`，不记录原始 Token。

## 回归验收

- `npm.cmd test`：38/38 通过。
- `npm.cmd run lint`：通过。
- `npx.cmd tsc --noEmit`：通过。
- `npm.cmd run build`：通过。
- 真实扫描一次：100 Listing、83 个唯一饰品、78 个国内价格匹配、31 个正价差；扫描未等待成交量补全。
- 浏览器实测：新列、真实 0、`STALE` 状态、最低成交量筛选和成交量降序均正常；筛选后前 50 行全部 >= 100 且严格降序。
- 连续刷新 20 次：页面恢复正常，无前端异常、无新的成交量上游请求。

## 产物与备份

- 数据库迁移前备份：`data/backups/stage-a-turnover-20260813-1507/`
- 真实 API 语义验证脚本：`scripts/verify-csqaq-turnover.mjs`
- 当前生产地址：`http://127.0.0.1:3000/`
