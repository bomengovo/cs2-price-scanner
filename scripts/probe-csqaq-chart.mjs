/**
 * Read-only CSQAQ /info/chart reconnaissance.
 *
 * This script never opens the local SQLite database, never calls CSFloat or
 * SteamDT, and never writes any configuration or result data. It reads the
 * existing CSQAQ_API_TOKEN only at runtime and deliberately never prints it.
 * It runs sequentially with a >=1100 ms interval because it is not inside the
 * Next.js process that owns the production global scheduler.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const token = readToken();
const intervalMs = Math.max(1_100, Number(process.env.CSQAQ_MIN_INTERVAL_MS ?? 1_100));
const chartEndpoint = "https://api.csqaq.com/api/v1/info/chart";
const detailEndpoint = "https://api.csqaq.com/api/v1/info/good";
let lastRequestAt = 0;
let requestCount = 0;

const argument = process.argv[2] ?? "baseline";
if (!new Set(["baseline", "good", "chart", "suite"]).has(argument)) {
  throw new Error("Usage: node scripts/probe-csqaq-chart.mjs [baseline|good|chart|suite] [goodId] [key] [platform] [period] [style]");
}

if (argument === "baseline") {
  const detail = await requestGood(7310);
  const chart = await requestChart({ good_id: "7310", key: "sell_price", platform: 1, period: "1095", style: "all_style" });
  print({ probe: "official-baseline", token: "CONFIGURED", requests: requestCount, detail, chart });
} else if (argument === "chart") {
  const [goodId, key, platform, period = "1095", style = "all_style"] = process.argv.slice(3);
  if (!goodId || !key || !platform) throw new Error("chart mode requires: goodId key platform [period] [style]");
  const chart = await requestChart({ good_id: goodId, key, platform: Number(platform), period, style });
  print({ probe: "chart", token: "CONFIGURED", requests: requestCount, input: { good_id: goodId, key, platform: Number(platform), period, style }, chart });
} else if (argument === "good") {
  const goodId = process.argv[3];
  if (!goodId) throw new Error("good mode requires: goodId");
  const detail = await requestGood(goodId);
  print({ probe: "good", token: "CONFIGURED", requests: requestCount, input: { good_id: goodId }, detail });
} else {
  const fixtures = [
    { sample: "normal-gun", goodId: "1041", name: "Galil AR | Rocket Pop (Minimal Wear)" },
    { sample: "sticker", goodId: "25904", name: "Sticker | Engine Start (Holo)" },
    { sample: "low-flow-agent", goodId: "11431", name: "Special Agent Ava | FBI" },
  ];
  const samples = [];
  for (const fixture of fixtures) {
    for (const platform of [1, 2]) {
      const chart = await requestChart({ good_id: fixture.goodId, key: "turnover_number", platform, period: "30", style: "all_style" });
      samples.push({ ...fixture, platform, chart });
    }
  }
  print({ probe: "daily-volume-suite", token: "CONFIGURED", requests: requestCount, samples });
}

function readToken() {
  const envFile = path.join(root, ".env.local");
  const content = fs.readFileSync(envFile, "utf8");
  const match = content.match(/(?:^|[^A-Za-z0-9_])CSQAQ_API_TOKEN\s*=\s*([^\s`#]+)/m);
  if (!match?.[1]?.trim()) throw new Error("CSQAQ_API_TOKEN 未配置");
  return match[1].trim();
}

async function requestGood(goodId) {
  const response = await scheduledFetch(`${detailEndpoint}?id=${encodeURIComponent(goodId)}`, { method: "GET" });
  const body = await parseJson(response);
  const data = asRecord(body.data);
  const goods = asRecord(data.goods_info ?? data.good_info ?? data);
  return {
    httpStatus: response.status,
    businessCode: numberOrNull(body.code),
    message: message(body.msg),
    marketHashName: textOrNull(goods.market_hash_name ?? goods.marketHashName),
    buffId: textOrNull(goods.buff_id ?? goods.buffId),
    yyypId: textOrNull(goods.yyyp_id ?? goods.yyypId),
    turnoverNumber: numberOrNull(goods.turnover_number),
    periodAt: textOrNull(goods.period_at),
  };
}

async function requestChart(body) {
  const response = await scheduledFetch(chartEndpoint, { method: "POST", body: JSON.stringify(body) });
  const parsed = await parseJson(response);
  const data = asRecord(parsed.data);
  return {
    httpStatus: response.status,
    businessCode: numberOrNull(parsed.code),
    message: message(parsed.msg),
    dataPresent: Object.keys(data).length > 0,
    timestamp: summarizeArray(data.timestamp),
    timestampIntervals: summarizeIntervals(data.timestamp),
    numData: summarizeArray(data.num_data),
    mainData: summarizeArray(data.main_data),
  };
}

async function scheduledFetch(url, init) {
  // A probe process can be invoked repeatedly from a shell.  Delay the first
  // request as well, so sequential invocations remain conservatively spaced
  // even though they do not share the production scheduler's memory.
  const earliestRequestAt = lastRequestAt || Date.now();
  const waitMs = Math.max(0, earliestRequestAt + intervalMs - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastRequestAt = Date.now();
  requestCount += 1;
  return fetch(url, {
    ...init,
    headers: { ApiToken: token, Accept: "application/json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
}

async function parseJson(response) {
  try { return await response.json(); } catch { return {}; }
}
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function textOrNull(value) { const text = String(value ?? "").trim(); return text || null; }
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function message(value) { return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 240) || null; }
function summarizeArray(value) {
  const values = Array.isArray(value) ? value : [];
  return {
    count: values.length,
    first: values.length ? values[0] : null,
    last: values.length ? values.at(-1) : null,
    head: values.slice(0, 3),
    tail: values.slice(-3),
  };
}
function summarizeIntervals(value) {
  if (!Array.isArray(value) || value.length < 2) return [];
  return [...new Set(value.slice(1).map((timestamp, index) => Number(timestamp) - Number(value[index])))].slice(0, 4);
}
function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
