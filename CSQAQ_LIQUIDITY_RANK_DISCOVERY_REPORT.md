# CSQAQ 流动性榜单侦察报告（Stage B0）

## 最终结论

**STAGE B0 = BLOCKED。**

公开榜单接口可以合法访问，也携带看似当前的库存/求购数量字段；但本轮证据不足以确认它是“成交量榜”，也无法确认 `rank_num` 是当前所选排序的名次。它没有 `good_id`、`market_hash_name`、`turnover_number`、`volume`、`updated_at` 或 `period_at`，所以不能可靠匹配 Stage A 商品，更不能把它接入为当前成交量或流动性排名。

对 Stage B 的建议为 **Option D**：继续使用 Stage A 的历史 `turnover_number` + 当前在售数量 + 当前求购数量（仅作为其各自独立字段）+ 利润。不要将本次 `rank_num`、`statistic` 或公开榜单顺序写入生产库、扫描结果或 UI。

## 侦察约束与执行摘要

- 探针：[scripts/probe-csqaq-liquidity-rank.mjs](scripts/probe-csqaq-liquidity-rank.mjs)，只读；SQLite 写入 0、扫描调用 0、CSFloat 调用 0、SteamDT 调用 0。
- Token 仅在进程内读取；输出始终为 `CSQAQ_API_TOKEN = CONFIGURED`，没有写入日志或本报告。
- 首轮探针执行 7 次请求：公开榜单 6 次（成交量页 1--5、在售数量页 1）+ 企业热度权限探测 1 次。随后仅为解析实际数组路径和 `statistic` 形状各做 1 次同一最小成交量榜请求；总计 9 次，未做重试、枚举或权限绕过。
- 探针的正式请求调度最小间隔为 1100ms；未触发 429。
- Stage A 数据、生产代码、默认排序、UI、扫描器和启动器均未修改。

## 1. PUBLIC VOLUME RANK API

| 项目 | 观察结果 |
| --- | --- |
| Endpoint | `POST /api/v1/info/get_rank_list` |
| 最小请求 | `{ "page_index": 1, "page_size": 20, "show_recently_price": false, "filter": { "排序": ["成交量"] } }` |
| HTTP / Business code | 每个已请求公开榜单均为 HTTP 200 / `code: 200` |
| `msg` | 空 |
| 当前页 | 响应 `data.current_page` 始终为 `1`；但第 2--5 请求分别返回 id 21--40、41--60、61--80、81--100，说明请求页参数改变了数据，`current_page` 本身不宜作可靠页码依据 |
| 单页条数 | 20 |
| 已检查商品 | 100（最多 5 页） |
| total / total_count / pages | 均未返回 |
| Available | **YES（接口可用）**，但**不是已确认的成交量榜** |

真实数组路径为 `data.data`。首三项的非敏感示例为：

| 行 | `id` | `name` | `statistic` | `rank_num` | `buff_sell_num` | `yyyp_sell_num` | `created_at` |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | 1 | 运动手套（★）\|迈阿密风云（略有磨损） | 8141 | 153 | 1063 | 996 | 2026-08-13T16:42:14 |
| 2 | 2 | 印花\|麻将·百中 | 0 | 265 | 160 | 178 | 2026-08-13T16:42:14 |
| 3 | 3 | 印花\|肉食主义 | 0 | 279 | 387 | 153 | 2026-08-13T16:42:14 |

## 2. 返回字段与语义

| 字段 | 存在 | 示例 | 当前可作出的结论 | 已确认 |
| --- | --- | --- | --- | --- |
| `id` | 是 | 1 | 榜单行标识/顺序候选；不能与 Stage A `good_id` 等同 | 否 |
| `good_id` | 否 | -- | 不存在 | 是 |
| `market_hash_name` | 否 | -- | 不存在 | 是 |
| `name` | 是 | 中文商品名 | 商品显示名；与 SQLite 英文 `marketHashName` 无可靠映射 | 仅显示名 |
| `rank_num` | 是 | 153 | 存在，但未证明是当前“成交量”排序名次 | 否 |
| `rank_num_change` | 否 | -- | 不存在 | 是 |
| `turnover_number` | 否 | -- | 不存在 | 是 |
| `volume` | 否 | -- | 不存在 | 是 |
| `statistic` | 是 | 8141、0、0 | 数值字段，但接口没有说明其统计口径；不能按字段名或请求排序猜作成交量 | 否 |
| `buff_sell_num` / `yyyp_sell_num` | 是 | 1063 / 996 | 当前榜单快照中的平台在售数量候选 | 字段存在；新鲜度未知 |
| `buff_buy_num` / `yyyp_buy_num` | 是 | 23 / 49 | 当前榜单快照中的平台求购数量候选 | 字段存在；新鲜度未知 |
| `created_at` | 是 | 2026-08-13T16:42:14 | 只有该时间字段；未证明它代表数据刷新时间 | 否 |
| `updated_at` / `period_at` | 否 | -- | 不存在 | 是 |

接口还提供价格历史候选字段（如 `sell_price_1`、`sell_price_7`、`sell_price_30`），本阶段只记录其存在，不用于趋势或评分。

## 3. 排序与 `rank_num` 验证

请求“成交量”后，前三条 `statistic` 为 **8141、0、0**，不是可验证的降序序列；同时没有任何已确认的成交量字段。因此不能因为接口接受了 `排序=["成交量"]` 就断言结果确为成交量榜。

以同样最小载荷请求 `排序=["在售数量"]` 后，第一页前三个 `id`、商品名和 `rank_num` 仍与“成交量”请求相同（1/153、2/265、3/279）。响应没有 `good_id`，且缺乏官方字段说明，不能证明筛选参数真的改变了排序，也不能把不变的 `rank_num` 解释成全局或当前榜单名次。

**`rank_num semantic: UNKNOWN`。**

## 4. 数据新鲜度

**Volume rank freshness: UNKNOWN。**

证据仅为所有已取行共享 `created_at = 2026-08-13T16:42:14`。这表面上与请求当天一致，且明显不同于 Stage A 的 2025 `period_at`，但字段名是 `created_at` 而非更新/统计时间，接口未提供 `updated_at`、`period_at`、`timestamp`、`data_time` 或元数据更新时间。按 Stage B0 的规则，不能把“今天请求成功”或“同日 created_at”直接判为 FRESH。

## 5. Stage A 对照

在最多 5 页（100 条）公开榜单中，以下 Stage A 样本均未能可靠匹配：榜单只有中文 `name`，没有 `good_id` 或完整 Steam `market_hash_name`，因此不能用翻译、名称猜测或位置猜测建立映射。

| Stage A 商品 | good_id | Stage A turnover_number | Stage A period_at | Rank 匹配 |
| --- | ---: | ---: | --- | --- |
| Dreams & Nightmares Case | 14675 | 148808 | 2025-11-06 | 未匹配 |
| Kilowatt Case | 19521 | 108793 | 2025-10-30 | 未匹配 |
| Recoil Case | 15447 | 105312 | 2025-10-28 | 未匹配 |
| M4A1-S \| Nitro（Field-Tested） | 1278 | 2125 | 2025-11-09 | 未匹配 |
| Sticker \| BLAST.tv \| Austin 2025 | 23031 | 3280 | 2025-11-22 | 未匹配 |
| ★ Bowie Knife \| Bright Water（Factory New） | 13929 | 26 | 2025-10-30 | 未匹配 |
| Special Agent Ava \| FBI | 11431 | 158 | 2025-11-06 | 未匹配 |

因此没有证据显示榜单 `statistic` 与 Stage A `turnover_number` 相同、不同或更新；三者均不能据此推断。

## 6. 库存交叉验证

公开榜单确实返回 `buff_sell_num`、`yyyp_sell_num`、`buff_buy_num`、`yyyp_buy_num`，而 SQLite 当前扫描结果也有相应平台数量字段。但由于 100 条样本内没有可靠商品 ID/完整名称匹配，**无法完成 5 条逐项 Rank API ↔ Scanner 对照**。不能把中文名称相似或非精确翻译当成匹配。

即使未来能建立正式映射，也必须分别判断这些库存字段与成交量、`statistic` 的刷新周期；不能把同一接口内所有字段统一视作新鲜数据。

## 7. 企业热度接口

| 项目 | 结果 |
| --- | --- |
| Endpoint | `POST /api/v1/info/get_popular_goods` |
| HTTP / Business code | HTTP 401 / `code: 401` |
| Message | 请求的地址非法，请更换请求链接 |
| 状态 | **NOT AUTHORIZED** |
| 后续动作 | 已停止；未重试、未变更 Header、未使用 Cookie 或网页登录态 |

## 8. 对 Stage B 的建议与停止条件

选择 **Option D**：当前没有比 Stage A 更可靠、同时具备可证实语义与新鲜度的 CSQAQ 当前成交量/成交量排名来源。

可以保留为未来侦察线索的内容仅有：公开榜单可访问、平台在售/求购字段存在、`created_at` 值表现为近期候选。它们尚不能进入任何 Opportunity Score、推荐、默认排序或正式 Schema。

本阶段到此停止；不实施 Stage B 权重、平台推荐、评级或购买建议。
