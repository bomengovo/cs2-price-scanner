import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const count = Math.min(5, Math.max(1, Number(process.argv[2] || 5)));
const envText = fs.readFileSync(path.join(root, ".env.local"), "utf8");
const match = envText.match(/(?:^|[^A-Za-z0-9_])CSQAQ_API_TOKEN\s*=\s*([^\s`#]+)/m);
const token = match?.[1]?.trim();
if (!token) throw new Error("CSQAQ_API_TOKEN 未配置");
if (process.argv.includes("--bind-ip")) {
  const bindResponse = await fetch("https://api.csqaq.com/api/v1/sys/bind_local_ip", { method: "POST", headers: { ApiToken: token, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const bindBody = await bindResponse.json().catch(() => ({}));
  console.log(JSON.stringify({ action: "bind-local-ip", httpStatus: bindResponse.status, apiCode: bindBody?.code ?? null, success: bindResponse.ok && bindBody?.code === 200 }));
  if (!bindResponse.ok || bindBody?.code !== 200) process.exitCode = 1;
  process.exit();
}
const database = new Database(path.join(root, "data", "scanner.db"), { readonly: true });
const names = database.prepare("SELECT market_hash_name AS name FROM scan_results WHERE is_deleted = 0 AND source = 'live' ORDER BY last_seen_at DESC LIMIT ?").all(count).map((row) => row.name);
database.close();
const startedAt = Date.now();
const response = await fetch("https://api.csqaq.com/api/v1/goods/getPriceByMarketHashName", { method: "POST", headers: { ApiToken: token, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ marketHashNameList: names }), signal: AbortSignal.timeout(20_000) });
const body = await response.json().catch(() => ({}));
const success = body?.data?.success && typeof body.data.success === "object" ? Object.values(body.data.success) : [];
const result = { httpStatus: response.status, apiCode: body?.code ?? null, message: String(body?.msg || "").slice(0, 200), requested: names.length, returned: success.length, buffParsed: success.filter((item) => Number.isFinite(Number(item?.buffSellPrice))).length, youpinParsed: success.filter((item) => Number.isFinite(Number(item?.yyypSellPrice))).length, marketHashNameExact: success.filter((item) => names.includes(String(item?.marketHashName))).length, durationMs: Date.now() - startedAt };
console.log(JSON.stringify(result));
if (!response.ok || body?.code !== 200 || success.length === 0) process.exitCode = 1;
