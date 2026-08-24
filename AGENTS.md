<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# CS2 价格扫描器 — 项目指南

## 概述
本地 CS2 选品工作台：CSFloat（海外真实 Listing）+ CSQAQ（国内价格）+ SteamDT（备用）。SQLite 永久保存历史结果。

## CSFloat 请求链路
```
fetchCSFloatListings() [csfloat.ts]
  → csfloatNeedsProbe()？先发 limit=1 最小验证
  → scheduleCsfloatListings() [csfloat-scheduler.ts] ← 全局单一队列 + 1500ms 限流
    → csfloatFetch() [csfloat-network.ts] ← undici + ProxyAgent（固定代理 CSFLOAT_PROXY）
```

## 关键文件
- `src/lib/csfloat-network.ts` — 代理、IP 检测、诊断
- `src/lib/csfloat-scheduler.ts` — 全局队列、429 分类、PROBE 状态机
- `src/lib/csfloat.ts` — 分页 + PROBE 触发
- `src/lib/env.ts` — `getCsfloatListingHeaders` → `Authorization: <KEY>`
- `src/lib/scanner.ts` — 扫描编排
- `src/components/scanner-dashboard.tsx` — 前端状态
- `tests/integration.test.ts` — 47 个测试
- `tests/egress-verify.test.ts` — 真实验证（RUN_CSFLOAT_EGRESS=1）

## 429 防护
- 固定代理（CSFLOAT_PROXY only，忽略 HTTP_PROXY/ALL_PROXY）
- 全局队列串行 + 1500ms（生产）
- 普通 429 → backoff；multi-IP 429 → 30min 冷却
- 冷却后 PROBE（limit=1 验证）→ 成功才恢复
- 后台每 60s IP 检测；变化 → 立即暂停
- 状态机：LIVE / RATE_LIMITED / PROBE / MULTI_IP_BLOCKED / IP_CHANGED / SNAPSHOT / UNAVAILABLE

## 不要做
- ❌ 因 429 改 Key / 删 Auth
- ❌ 无限制重试
- ❌ 影响 CSQAQ / SteamDT
- ❌ 多 Worker 各自限流
- ❌ 绕过全局 scheduler
