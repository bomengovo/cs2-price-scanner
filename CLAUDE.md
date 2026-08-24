@AGENTS.md

# CS2 价格扫描器 — 会话记忆

## 当前运行状态
- 服务器：http://127.0.0.1:3000（supervisor 管理，单进程 next start）
- 代理：CSFLOAT_PROXY=http://127.0.0.1:7897（固定，忽略 HTTP_PROXY/ALL_PROXY）
- 出口 IP：103.172.183.81（通过代理一致）
- API Key：已配置（Authorization: <KEY> 格式，.env.local CSFLOAT_API_KEY）
- 数据库：data/scanner.db（SQLite WAL）

## 429 事件时间线
- 2026-08-12 ~ 08-19：多次 "too many requests from too many IPs"（根因：未固定代理，出口 IP 多变）
- 2026-08-19 13:56：配置 CSFLOAT_PROXY=127.0.0.1:7897 后重启，IP 固定 103.172.183.81
- 2026-08-19 14:34：真实验证通过（HTTP 200，CF-Ray HKG，同一出口 IP）
- 结论：Key 有效，429 是多 IP 触发，固定代理后解决

## 本次修改（2026-08-19）
1. PROBE 状态机：冷却结束后先发 limit=1 最小请求验证，成功才恢复
2. 后台 IP 定时检测：每 60s 刷新 ipify，IP 变化立即暂停+日志
3. 前端标签：ONLINE/RATE LIMITED/MULTI-IP BLOCKED/IP CHANGED/PROBE/COOLDOWN
4. 前端增加：出口 IP、冷却剩余、上次 429 时间与原因（5s 轮询）
5. 测试：47 单元测试 + 5 真实网络验证（默认跳过）

## 完整测试命令
- npm test（47 passed，egress 默认跳过）
- RUN_CSFLOAT_EGRESS=1 npx vitest run tests/egress-verify.test.ts（真实网络）
- npx tsc --noEmit（类型检查）
- npm run build（生产构建）
- stop.bat / start.bat（重启服务器）
