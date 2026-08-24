/**
 * Stage B0.1: exactly one read-only CSQAQ popular-goods request.
 * No SQLite access, no retry, no CSFloat/SteamDT access, and no secret output.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const endpoint = "https://api.csqaq.com/api/v1/info/get_popular_goods";
const token = readToken();
const startedAt = Date.now();

let response;
let body = {};
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: { ApiToken: token, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ page_index: 1, page_size: 20 }),
    signal: AbortSignal.timeout(20_000),
  });
  body = await response.json().catch(() => ({}));
} catch (error) {
  print({ httpStatus: null, apiCode: null, message: safe(error instanceof Error ? error.message : "request failed"), durationMs: Date.now() - startedAt, rows: [], rootKeys: [], dataKeys: [] });
  process.exitCode = 1;
  process.exit();
}

const rootBody = record(body);
const data = record(rootBody.data);
const rows = findRows(body).slice(0, 20);
const output = {
  probe: "csqaq-popular-goods-stage-b01",
  token: "CONFIGURED",
  safeguards: { sqliteWrites: 0, csfloatCalls: 0, steamdtCalls: 0, retries: 0, requests: 1 },
  endpoint: "/api/v1/info/get_popular_goods",
  httpStatus: response.status,
  apiCode: number(rootBody.code),
  message: safe(String(rootBody.msg ?? rootBody.message ?? "")),
  durationMs: Date.now() - startedAt,
  rootKeys: Object.keys(rootBody).sort(),
  dataKeys: Object.keys(data).sort(),
  rowCountInResponse: findRows(body).length,
  itemKeys: [...new Set(rows.flatMap((item) => Object.keys(record(item))) )].sort(),
  timeFields: [...new Set(rows.flatMap((item) => Object.keys(record(item)).filter((key) => /created|updated|period|timestamp|time|date/i.test(key))))].sort(),
  samples: rows.slice(0, 3).map(safeRow),
  rows: rows.map(normalize),
};
print(output);
if (response.status === 401 || response.status === 403 || number(rootBody.code) === 401 || number(rootBody.code) === 403) process.exitCode = 2;
else if (!response.ok || rootBody.code !== 200) process.exitCode = 1;
else if (!output.itemKeys.includes("market_hash_name") || !output.itemKeys.includes("turnover_number")) process.exitCode = 3;

function readToken() {
  const contents = fs.readFileSync(path.join(root, ".env.local"), "utf8");
  const match = contents.match(/(?:^|[^A-Za-z0-9_])CSQAQ_API_TOKEN\s*=\s*([^\s`#]+)/m);
  if (!match?.[1]?.trim()) throw new Error("CSQAQ_API_TOKEN is not configured");
  return match[1].trim();
}
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function findRows(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value) && value.every((item) => item && typeof item === "object")) return value;
  for (const key of ["list", "rows", "items", "goods", "goods_list", "data_list", "records", "result", "data"]) {
    const found = findRows(record(value)[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}
function number(value) { const result = Number(value); return Number.isFinite(result) ? result : null; }
function text(value) { const result = String(value ?? "").trim(); return result || null; }
function normalize(item) {
  const value = record(item);
  return {
    id: number(value.id), goodId: number(value.good_id ?? value.goodId), marketHashName: text(value.market_hash_name ?? value.marketHashName), name: text(value.name),
    turnoverNumber: number(value.turnover_number ?? value.turnoverNumber), rankNum: number(value.rank_num ?? value.rankNum), rankNumChange: number(value.rank_num_change ?? value.rankNumChange),
    buffSellNum: number(value.buff_sell_num ?? value.buffSellNum), buffBuyNum: number(value.buff_buy_num ?? value.buffBuyNum), yyypSellNum: number(value.yyyp_sell_num ?? value.yyypSellNum), yyypBuyNum: number(value.yyyp_buy_num ?? value.yyypBuyNum),
    createdAt: text(value.created_at ?? value.createdAt), updatedAt: text(value.updated_at ?? value.updatedAt ?? value.update_time ?? value.updateTime), periodAt: text(value.period_at ?? value.periodAt ?? value.data_time ?? value.dataTime),
  };
}
function safeRow(item) { return Object.fromEntries(Object.entries(normalize(item)).filter(([, value]) => value != null)); }
function safe(value) { return value.replaceAll(token, "[REDACTED]").slice(0, 300); }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
