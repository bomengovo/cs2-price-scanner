/**
 * Read-only Stage A verifier for the CSQAQ item-level turnover indicator.
 * It does not write SQLite, trigger a scanner run, or contact CSFloat/SteamDT.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const endpoint = "https://api.csqaq.com/api/v1/info/good";
const minIntervalMs = Math.max(1_100, Number(process.env.CSQAQ_MIN_INTERVAL_MS ?? 1_100));
const token = readToken();
let lastRequestAt = 0;

const fixtures = [
  { category: "gun", goodId: 48, expectedName: "AK-47 | Bloodsport (Minimal Wear)" },
  { category: "gun", goodId: 51, expectedName: "AK-47 | Blue Laminate (Field-Tested)" },
  { category: "gun", goodId: 30, expectedName: "AK-47 | Elite Build (Battle-Scarred)" },
  { category: "gun", goodId: 1041, expectedName: "Galil AR | Rocket Pop (Minimal Wear)" },
  { category: "sticker", goodId: 25934, expectedName: "Sticker | Aceberry (Glitter)" },
  { category: "sticker", goodId: 23031, expectedName: "Sticker | BLAST.tv | Austin 2025" },
  { category: "sticker", goodId: 25904, expectedName: "Sticker | Engine Start (Holo)" },
  { category: "sticker", goodId: 15632, expectedName: "Sticker | Exo Jumper" },
  { category: "knife-glove", goodId: 13929, expectedName: "★ Bowie Knife | Bright Water (Factory New)" },
  { category: "knife-glove", goodId: 12874, expectedName: "★ Broken Fang Gloves | Jade (Field-Tested)" },
  { category: "agent", goodId: 11498, expectedName: "B Squadron Officer | SAS" },
  { category: "agent", goodId: 11431, expectedName: "Special Agent Ava | FBI" },
];

const samples = [];
for (const fixture of fixtures) samples.push(await fetchSample(fixture));
const numericVolumes = samples.map((sample) => sample.turnoverNumber).filter((value) => value != null);
const orderedVolumes = [...numericVolumes].sort((left, right) => left - right);
process.stdout.write(`${JSON.stringify({
  probe: "csqaq-turnover-semantic-verification",
  token: "CONFIGURED",
  requestCount: samples.length,
  minIntervalMs,
  samples,
  summary: {
    success: samples.filter((sample) => sample.httpStatus === 200 && sample.businessCode === 200).length,
    noVolume: samples.filter((sample) => sample.turnoverNumber == null).length,
    realZero: samples.filter((sample) => sample.turnoverNumber === 0).length,
    periodAt: [...new Set(samples.map((sample) => sample.periodAtShanghai).filter(Boolean))],
    lowVolume: orderedVolumes.at(0) ?? null,
    highVolume: orderedVolumes.at(-1) ?? null,
  },
})}\n`);

function readToken() {
  const content = fs.readFileSync(path.join(root, ".env.local"), "utf8");
  const match = content.match(/(?:^|[^A-Za-z0-9_])CSQAQ_API_TOKEN\s*=\s*([^\s`#]+)/m);
  if (!match?.[1]?.trim()) throw new Error("CSQAQ_API_TOKEN 未配置");
  return match[1].trim();
}

async function fetchSample(fixture) {
  await waitForTurn();
  lastRequestAt = Date.now();
  const response = await fetch(`${endpoint}?id=${encodeURIComponent(fixture.goodId)}`, {
    method: "GET",
    headers: { ApiToken: token, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  const root = asRecord(body.data);
  const info = asRecord(root.goods_info ?? root.good_info ?? root);
  const name = textOrNull(info.market_hash_name ?? info.marketHashName);
  const periodAt = textOrNull(info.period_at ?? info.periodAt);
  return {
    category: fixture.category,
    goodId: fixture.goodId,
    expectedName: fixture.expectedName,
    httpStatus: response.status,
    businessCode: numberOrNull(body.code),
    marketHashName: name,
    nameMatchesExpected: name === fixture.expectedName,
    turnoverNumber: numberOrNull(info.turnover_number ?? info.turnoverNumber),
    turnoverAvgPrice: numberOrNull(info.turnover_avg_price ?? info.turnoverAvgPrice),
    periodAt,
    periodAtShanghai: toShanghai(periodAt),
    buffId: textOrNull(info.buff_id ?? info.buffId),
    yyypId: textOrNull(info.yyyp_id ?? info.yyypId),
  };
}

async function waitForTurn() {
  const waitMs = Math.max(0, lastRequestAt + minIntervalMs - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
}
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function textOrNull(value) { const text = String(value ?? "").trim(); return text || null; }
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function toShanghai(value) {
  if (!value) return null;
  const date = new Date(value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}+08:00`);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(date);
}
