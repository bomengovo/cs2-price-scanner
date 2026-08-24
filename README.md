# CS2 跨平台价差扫描器

本项目是本地运行的 CS2 选品工作台。CSFloat 提供海外真实在售 Listing；CSQAQ 是 BUFF 与悠悠有品价格的主数据源；SteamDT 只在整批 CSQAQ 请求失败时作为备用；SQLite 永久保存按完整 `marketHashName` 去重后的历史结果。

## 日常使用

- 启动：双击 `start.bat`
- 停止：双击 `stop.bat`
- 诊断：双击 `diagnose.bat`
- 生产验收：双击 `verify-production.bat`
- 强制重建：双击 `rebuild.bat`

启动器会检查 Node.js、依赖、配置、数据库、Build、PID、TCP 监听与实例身份。3000 被其他程序占用时会安全选择 3001–3010，并打开实际端口。启动脚本退出后，后台服务继续运行。

## 数据与 Provider

```text
CSFloat Listing
  -> 完整 marketHashName 去重并选择最低成本 Listing
  -> CSQAQ 每批最多 50 件、全进程排队、请求间隔至少 1.1 秒
  -> BUFF / 悠悠有品价格
  -> SQLite 持久合并
```

只有 CSQAQ 的整批请求发生 HTTP、网络、鉴权或解析失败时，才调用一次 SteamDT 整批备用。单个商品缺失不会触发逐商品 fallback。刷新国内价格只读取已有 `scan_results` 并调用国内 Provider，不会请求 CSFloat，也不会改变保存商品数量。

CSFloat 429 会写入 SQLite 冷却状态并停止本轮硬请求；存在 Snapshot 时继续展示缓存。限流不会清空历史结果或阻止网站启动。

CSFloat 请求**只走固定的 `CSFLOAT_PROXY`**（故意忽略 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`），并由**全局单一调度器**限流（生产环境最小间隔 1500ms，跨 worker 共享 SQLite 冷却状态），避免多个 Worker 各自限流把上游打爆。程序会定期检测出口公网 IP（ipify，走同一代理路径）：

- 启动时记录 `startupPublicIp`，之后每 `CSFLOAT_IP_CHECK_INTERVAL_MS`（默认 60s）刷新一次；
- 若 IP 变化，立即持久化 `CSFLOAT_IP_CHANGED` 暂停并进入 `CSFLOAT_MULTI_IP_COOLDOWN_MS`（默认 30 分钟）冷却；
- 冷却结束后，下一次扫描先发送**一个最小探针请求（PROBE）**验证恢复，成功才恢复正式翻页；失败则重新进入冷却，不做无限重试。

## 配置

复制 `.env.example` 为 `.env.local`，仅在 `.env.local` 填写真实凭据。凭据只在 Next.js 服务端读取，不会进入浏览器响应、前端 Bundle、README 或日志。

```dotenv
CSFLOAT_API_KEY=
CSQAQ_API_TOKEN=
STEAMDT_API_KEY=

USD_CNY_RATE=7.2000
DOMESTIC_PROVIDER=csqaq
MOCK_MODE=false
CSFLOAT_LISTINGS_AUTH_REQUIRED=true
# CSFloat 只使用这个固定 HTTP(S) 代理；请固定 VPN/Clash 节点，禁止节点自动切换。
CSFLOAT_PROXY=
CSFLOAT_MULTI_IP_COOLDOWN_MS=1800000
CSFLOAT_IP_CHECK_INTERVAL_MS=60000
CSFLOAT_PAUSE_ON_IP_CHANGE=true
STEAMDT_BATCH_INTERVAL_MS=60000
```

`.env.local`、`data/`、`logs/` 与 `runtime/` 都是本机运行数据，不应提交到 Git。数据库默认是 `data/scanner.db`，使用 WAL、事务和 5 秒 `busy_timeout`。

## 数据规则

- 唯一键始终是完整 `marketHashName`；StatTrak、Souvenir 与不同磨损互不合并。
- 扫描会新增或更新更优 Listing，不会整表替换历史。
- 软删除商品后，后续扫描不会自动恢复；只能由用户主动恢复。
- `sellCount` 是当前在售数量，`dailyVolume` 是今日成交数量；缺失显示 `--`，不会用 0 或在售数量伪造。
- 人民币是主显示价格，美元仅作辅助。

## 开发验证

```powershell
npm.cmd test
npm.cmd run lint
npx.cmd tsc --noEmit
npm.cmd run build
```

生产检查会验证 `/api/health`、首页、`/api/results`、`/api/settings`、`/api/rate-status`、静态 JS/CSS 与真实 Chromium 渲染。详细运行日志位于 `logs/`，日志只记录 Provider、状态码、批量大小、等待时间与计数，不记录凭据。
