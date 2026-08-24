# CSQAQ 日成交量参数侦察报告

生成时间：2026-08-13（Asia/Shanghai）  
结论：`CSQAQ DAILY VOLUME DISCOVERY = PARTIAL`

## 范围与安全边界

- `CSQAQ_API_TOKEN = CONFIGURED`；本次只从既有 `.env.local` 读取，未修改、输出或记录其值。
- 侦察脚本为 `scripts/probe-csqaq-chart.mjs`，只访问 CSQAQ 公共 API；不读写 SQLite、不执行扫描、不调用 CSFloat 或 SteamDT。
- 每次探针 HTTP 请求前至少等待 1100ms；总请求数为 12，处于本阶段约定的上限内。
- 未抓取 BUFF 成交记录，也没有更改利润、排序、扫描器 UI、启动器或平台链接。

## 已确认的官方基线

| 请求 | HTTP | 业务 code | 结果 |
| --- | ---: | ---: | --- |
| `GET /api/v1/info/good?id=7310` | 200 | 200 | `★ M9 Bayonet \| Doppler (Factory New)`；BUFF ID `43091`；悠悠有品 ID `754` |
| `POST /api/v1/info/chart`，`{good_id:"7310",key:"sell_price",platform:1,period:"1095",style:"all_style"}` | 200 | 200 | `timestamp`、`num_data`、`main_data` 均为 1296 点 |

价格基线首末时间戳为 `1674576000000` 与 `1786464000000`。后者换算为
Asia/Shanghai 的 `2026-08-12 00:00:00 +08:00`，证明 Chart 路由、Token、IP、商品 ID、价格参数和历史时间序列均可用。

## 页面与请求形状证据

直接浏览 CSQAQ 商品页的自动化会话在外部页面加载阶段超时，因而未读取 Cookie、登录态、Token 或会话数据。按预案改为审计页面公开打包代码：

- 页面标签把 `turnover_number` 明确显示为“日成交量”。
- 平台选项映射为 `1 = BUFF`、`2 = 悠悠有品`、`3 = Steam`，二者没有混用。
- 图表状态变化提交的结构为 `{ good_id, key, platform, period, style }`；默认款式值为 `all_style`，常用图表周期包含 `7`、`15`、`30`、`90`、`180`、`365`、`1095`。

这足以确认候选参数名和请求形状，但**不能单独证明返回数值的统计口径**。

## 受控实测矩阵

所有下列日成交量候选请求使用：

```json
{"key":"turnover_number","period":"30","style":"all_style"}
```

| 样本 | CSQAQ good_id | 平台 | HTTP | 业务 code | 数据数组 |
| --- | ---: | --- | ---: | ---: | --- |
| ★ M9 Bayonet \| Doppler (FN) | 7310 | BUFF | 200 | 404 | 空 |
| ★ M9 Bayonet \| Doppler (FN) | 7310 | 悠悠有品 | 200 | 404 | 空 |
| Galil AR \| Rocket Pop (MW)，普通枪械 | 1041 | BUFF | 200 | 404 | 空 |
| Galil AR \| Rocket Pop (MW)，普通枪械 | 1041 | 悠悠有品 | 200 | 404 | 空 |
| Sticker \| Engine Start (Holo)，贴纸 | 25904 | BUFF | 200 | 404 | 空 |
| Sticker \| Engine Start (Holo)，贴纸 | 25904 | 悠悠有品 | 200 | 404 | 空 |
| Special Agent Ava \| FBI，低流通品 | 11431 | BUFF | 200 | 404 | 空 |
| Special Agent Ava \| FBI，低流通品 | 11431 | 悠悠有品 | 200 | 404 | 空 |

为排除普通枪械映射错误，额外核验 `GET /api/v1/info/good?id=1041`：HTTP 200 / code 200，名称与样本一致，BUFF ID `34941`，悠悠有品 ID `2609`。因此同一候选参数在两个有效平台映射上均未返回序列，不是将 BUFF 与悠悠有品混为一谈造成的结果。

另有一次早期探针命令行索引错误，服务端返回 HTTP 422；脚本随后修正，该错误不参与上述参数结论。

## 响应语义与日期语义

- HTTP 成功不代表业务成功：`HTTP 200 + code 404 + 空 data` 被严格视为“图表业务未命中/不可用”，绝不等同于日成交量 0。
- `/info/good` 中存在 `turnover_number`（例如 good 1041 为 `116`），但没有获得可对照的日图表序列，不能证明它是目标自然日的 BUFF 或悠悠有品成交量，故未接入。
- `sell_price` 图表存在上海时区零点的历史点；由于日成交量图表没有任何可用 timestamp / main_data / num_data，无法验证其“数据日期”与 Asia/Shanghai 自然日之间的对应关系。该语义保持为 **未验证**。

## 最小生产处理

已在 `src/lib/csqaq.ts` 将已有成交量分支改为安全门禁：在发现未完成前直接返回
`volume: null`、`status: "unavailable"`、`source: "csqaq-chart-unavailable-discovery-incomplete"`，且不发送 Chart 请求。

这保留了当前页异步成交量接口、缓存结构、单飞与优先级调度的兼容性，同时避免每次扫描向 CSQAQ 重复发送必然返回业务 404 的请求，也避免把未知数据伪装为 0 或真实日成交量。

## 验证与稳定性

- `npm.cmd test`：PASS（35 tests）
- `npm.cmd run lint`：PASS
- `npx.cmd tsc --noEmit`：PASS
- `npm.cmd run build`：PASS
- 生产实例已受控重启，`/api/health`：PASS；20 秒、2 分钟与 5 分钟复核均为同一 PID `17544`、实例 ID，数据库状态正常。
- 既有测试中的 BUFF / 悠悠有品 URL 规则与多件商品链接回归通过。

## 后续前置条件

在 CSQAQ 为 `turnover_number` 返回至少一个非空、可复现的两平台日序列，并能以页面图表或官方说明确认数值口径与上海自然日之前，不应恢复 Chart 轮询或把该字段用于筛选、排序、利润权重或推荐。
