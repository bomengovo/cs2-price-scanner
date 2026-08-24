# CS2 Price Scanner 最终验收报告

验收时间：2026-08-12 23:04（Asia/Shanghai）  
项目路径：`D:\Codex\Projects\cs2-price-scanner`  
结论：**PASS，可作为当前生产版本继续使用。**

## 1. 最终运行实例

| 项目 | 结果 |
| --- | --- |
| 访问地址 | `http://127.0.0.1:3000/` |
| 运行模式 | Next.js production |
| PID | `34908` |
| Instance ID | `b0892e77-4c6b-43bd-8506-bdc00d1422fd` |
| Build ID | `9MoNQRT1TqJQdPKmCBPYY` |
| Node.js | `v24.18.0` |
| 应用版本 | `0.1.0` |
| Git 状态 | 当前目录不是 Git checkout，无法提供 commit hash |

健康检查返回 `status=ok`、数据库 `ok`、schema `3`、保存结果 `326` 条。最终生产验证脚本对主页、API、静态资源、进程、端口、浏览器渲染全部判定为 PASS。

## 2. P0：CSQAQ 正式链路与全局节流

- 国内价格主提供方为 `csqaq`，mock 模式关闭；SteamDT 仅保留为回退源。
- CSQAQ 批量接口按每批最多 50 个 `marketHashName` 切片；49、50、51、100、101 条边界均有自动测试覆盖。
- 所有 CSQAQ 批量请求统一进入进程级调度器；生产最小启动间隔为 1100 ms，相同批次支持 single-flight 合并，并持久化最近请求时间。
- 真实 100 条扫描产生 67 个唯一名称和 2 个 CSQAQ 批次。两个批次实际启动时间为 `14:57:04.984Z`、`14:57:06.099Z`，间隔 1115 ms，符合节流要求。
- 首次真实验证曾返回 401，服务端明确指出当前出口 IP 与账号绑定 IP 不一致；调用 CSQAQ 官方本机 IP 绑定接口成功后，5 个真实名称请求返回 HTTP 200 / code 200，BUFF 与悠悠有品均解析 5/5，名称精确匹配 5/5。没有修改或输出任何 API Key。
- 对 429 实施共享冷却；同一轮不进行无界重试，错误信息保留真实 provider/status，不再把认证、绑定或网络错误误报为“请求过于频繁”。

## 3. 真实扫描与刷新

真实 100 条扫描结果：

| 指标 | 结果 |
| --- | ---: |
| CSFloat 请求 | 2 |
| 原始 Listing | 100 |
| 唯一 marketHashName | 67 |
| CSQAQ 批次 | 2 |
| CSQAQ 匹配 | 67 |
| SteamDT 请求 | 0 |
| 新增 / 更新 / 保留 | 62 / 2 / 3 |
| 正价差机会 | 17 |
| 扫描后总保存量 | 326 |
| 总耗时 | 3494 ms |

真实刷新 100 条结果：provider 为 `csqaq`，更新 100 条，CSQAQ 2 批，SteamDT 0 次，CSFloat 请求增量 0；刷新前后保存量均为 264，没有破坏现有数据。随后真实扫描将数据库增加至 326 条。

## 4. 数据库与数据完整性

- SQLite schema version：3（应用健康检查）。
- `scan_results`：326 条。
- 按 `market_hash_name` 分组的重复项：0。
- 启动前备份：`backups\pre-final-hardening-20260812-222245`，包含 `scanner.db`、WAL 与 SHM 快照。
- 数据库连接配置 `busy_timeout=5000`，写入仍由现有事务和去重约束保护。

## 5. 启动器、停止器与端口安全

启动脚本使用实例 ID、健康检查、TCP owning PID 和进程命令行交叉确认，不依赖单独 PID 文件做危险终止。专项测试全部 PASS：

- 错误 PID：未误杀测试 Node 进程。
- 过期 PID：可安全恢复。
- 3000 端口冲突：自动改用 3001，未杀死占用者。
- 冲突解除后最终重启：恢复 3000。
- 服务由独立生产进程承载，启动 PowerShell 退出后仍可持续运行。

## 6. 三轮生产循环

| 循环 | PID | 初始检查 | 60 秒后 | 保存量变化 |
| --- | ---: | --- | --- | --- |
| 1 | 36280 | PASS | PASS | 264 → 264 |
| 2 | 13920 | PASS | PASS | 264 → 264 |
| 3（重建） | 36516 | PASS | PASS | 264 → 264 |

三轮均为端口 3000、浏览器 PASS、console error 0、page error 0，且保存量未下降。

## 7. 浏览器与图片

- 最终 in-app 浏览器复核：50 行、50 个唯一行签名、重复行 0、图片 50 张、破图 0、可见错误 0。
- 页面显示 `CSQAQ LIVE` 和数据库保存量 326。
- 独立 Edge/CDP smoke test：静态脚本 11、样式 1、表格 50 行、破图 0、console error 0、page error 0、request failure 0。
- 外部图片抽查中 45/50 通过备用 CDN 返回 HTTP 200，剩余 5 个使用内置占位图；最终浏览器层面 0 破图。

## 8. 工程检查

| 检查 | 结果 |
| --- | --- |
| `npm test` | PASS，34/34 |
| `npm run lint` | PASS |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS |
| `scripts\verify-production.ps1` | PASS |
| `scripts\diagnose.ps1` | PASS |

## 9. 最终操作入口

- 启动：`start.bat`
- 安全停止：`stop.bat`
- 诊断：`diagnose.bat`
- 生产验收：`verify-production.bat`
- 重建：`rebuild.bat`

当前生产服务已保持运行，地址为 `http://127.0.0.1:3000/`。
