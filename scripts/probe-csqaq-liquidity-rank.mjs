/**
 * Stage B0 read-only CSQAQ liquidity-rank probe.
 *
 * It never writes SQLite, starts a scan, calls CSFloat/SteamDT, or changes UI.
 * Token values are intentionally never emitted; output says CONFIGURED only.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const rankEndpoint = "https://api.csqaq.com/api/v1/info/get_rank_list";
const popularEndpoint = "https://api.csqaq.com/api/v1/info/get_popular_goods";
const token = readToken();
const minIntervalMs = Math.max(1_100, Number(process.env.CSQAQ_MIN_INTERVAL_MS ?? 1_100));
const maxVolumePages = 5;
let lastRequestAt = 0;
const requests = [];

const stageA = readStageASamples();
const volumePages = [];
const firstVolume = await requestRank({ label: "成交量", pageIndex: 1 });
volumePages.push(firstVolume);
if (firstVolume.ok) {
  for (let pageIndex = 2; pageIndex <= maxVolumePages && !hasAllRequiredMatches(volumePages, stageA.required); pageIndex += 1) {
    volumePages.push(await requestRank({ label: "成交量", pageIndex }));
  }
}

// This one small, different sort is solely for rank_num semantic comparison.
const sellQuantity = firstVolume.ok ? await requestRank({ label: "在售数量", pageIndex: 1 }) : skipped("在售数量", "成交量榜请求未成功，未进行 rank_num 对照");

// One permission-respecting probe only. Never retry or change headers/payload.
const popular = await requestPopular();
const rankRows = volumePages.flatMap((page) => page.rows ?? []);
const crossMatches = matchStageA(rankRows, stageA.required);
const freshness = determineFreshness(volumePages);

process.stdout.write(`${JSON.stringify({
  probe: "csqaq-liquidity-rank-stage-b0",
  token: "CONFIGURED",
  safeguards: {
    readOnly: true,
    databaseWrites: 0,
    scannerCalls: 0,
    csfloatCalls: 0,
    steamdtCalls: 0,
    minIntervalMs,
    maxPublicRankRequests: 8,
    maxEnterpriseRequests: 1,
  },
  requestCount: requests.length,
  requests,
  publicVolumeRank: summarizePages(volumePages),
  sellQuantityRank: sellQuantity,
  rankNumComparison: compareRankNums(firstVolume.rows ?? [], sellQuantity.rows ?? []),
  stageASamples: stageA.required,
  crossMatches,
  volumeRankFreshness: freshness,
  enterprisePopular: popular,
}, null, 2)}\n`);

function readToken() {
  const content = fs.readFileSync(path.join(root, ".env.local"), "utf8");
  const match = content.match(/(?:^|[^A-Za-z0-9_])CSQAQ_API_TOKEN\s*=\s*([^\s`#]+)/m);
  if (!match?.[1]?.trim()) throw new Error("CSQAQ_API_TOKEN is not configured");
  return match[1].trim();
}

function readStageASamples() {
  const database = new Database(path.join(root, "data", "scanner.db"), { readonly: true });
  const rows = database.prepare(`
    SELECT r.market_hash_name AS marketHashName, r.result_json AS resultJson,
           m.csqaq_good_id AS goodId, m.turnover_number AS turnoverNumber, m.period_at AS periodAt
    FROM scan_results r
    JOIN csqaq_item_metadata m ON m.market_hash_name = r.market_hash_name
    WHERE r.is_deleted = 0 AND m.turnover_number IS NOT NULL
  `).all();
  const wanted = [
    "Dreams & Nightmares Case", "Kilowatt Case", "Recoil Case",
    "M4A1-S | Nitro (Field-Tested)", "Desert Eagle | Heat Treated (Battle-Scarred)",
    "Sticker | BLAST.tv | Austin 2025", "Sticker | Grayhound Gaming | Paris 2023",
    "★ Bowie Knife | Bright Water (Factory New)", "Special Agent Ava | FBI",
  ];
  const indexed = new Map(rows.map((row) => [row.marketHashName, row]));
  return {
    required: wanted.map((name) => toStageASample(indexed.get(name))).filter(Boolean),
    savedItemCount: rows.length,
  };
}

function toStageASample(row) {
  if (!row) return null;
  const result = parseRecord(row.resultJson);
  return {
    marketHashName: row.marketHashName,
    goodId: finiteNumber(row.goodId),
    stageATurnoverNumber: finiteNumber(row.turnoverNumber),
    stageAPeriodAt: text(row.periodAt),
    scannerBuffSellNum: finiteNumber(result.buff?.sellCount),
    scannerYyypSellNum: finiteNumber(result.youpin?.sellCount),
    scannerBuffBuyNum: finiteNumber(result.buff?.bidCount),
    scannerYyypBuyNum: finiteNumber(result.youpin?.bidCount),
  };
}

async function requestRank({ label, pageIndex }) {
  const payload = { page_index: pageIndex, page_size: 20, show_recently_price: false, filter: { "排序": [label] } };
  const response = await requestJson({ endpoint: rankEndpoint, payload, kind: `public-rank:${label}:page-${pageIndex}` });
  return rankResult(response, { label, pageIndex });
}

async function requestPopular() {
  const response = await requestJson({ endpoint: popularEndpoint, payload: { page_index: 1, page_size: 20 }, kind: "enterprise-popular:page-1" });
  const body = response.body;
  return {
    endpoint: "/api/v1/info/get_popular_goods",
    authorization: response.businessCode === 200 ? "AUTHORIZED" : "NOT AUTHORIZED",
    httpStatus: response.httpStatus,
    businessCode: response.businessCode,
    message: response.message,
    currentPage: response.currentPage,
    total: response.total,
    dataLength: response.rows.length,
    itemKeys: response.rows[0] ? Object.keys(response.rows[0]) : [],
    sampleRows: response.rows.slice(0, 3).map(toSafeRow),
    // Do not expose arbitrary response payloads, especially on denied endpoints.
    responseShape: body && typeof body === "object" ? Object.keys(body) : [],
  };
}

async function requestJson({ endpoint, payload, kind }) {
  await waitForTurn();
  lastRequestAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ApiToken: token, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({}));
    const rows = findRows(body);
    const record = asRecord(body);
    const data = asRecord(record.data);
    const result = {
      endpoint: new URL(endpoint).pathname,
      kind,
      httpStatus: response.status,
      businessCode: finiteNumber(record.code),
      message: sanitize(text(record.msg ?? record.message ?? data.msg)),
      currentPage: finiteNumber(record.current_page ?? record.currentPage ?? data.current_page ?? data.currentPage ?? data.page_index),
      total: finiteNumber(record.total ?? record.total_count ?? data.total ?? data.total_count),
      rows,
      body,
    };
    requests.push({ kind, endpoint: result.endpoint, httpStatus: result.httpStatus, businessCode: result.businessCode, message: result.message });
    return result;
  } catch (error) {
    const result = { endpoint: new URL(endpoint).pathname, kind, httpStatus: null, businessCode: null, message: sanitize(error instanceof Error ? error.message : "request failed"), currentPage: null, total: null, rows: [], body: null };
    requests.push({ kind, endpoint: result.endpoint, httpStatus: null, businessCode: null, message: result.message });
    return result;
  }
}

function rankResult(response, { label, pageIndex }) {
  return {
    label,
    pageIndex,
    ok: response.httpStatus === 200 && response.businessCode === 200,
    httpStatus: response.httpStatus,
    businessCode: response.businessCode,
    message: response.message,
    currentPage: response.currentPage,
    total: response.total,
    dataLength: response.rows.length,
    itemKeys: response.rows[0] ? Object.keys(response.rows[0]) : [],
    firstThree: response.rows.slice(0, 3).map(toSafeRow),
    rows: response.rows.map(toRankRow),
    responseTimeFields: collectTimeFields(response.rows),
  };
}

function skipped(label, reason) {
  return { label, skipped: true, reason, httpStatus: null, businessCode: null, message: null, currentPage: null, total: null, dataLength: 0, itemKeys: [], firstThree: [], rows: [], responseTimeFields: [] };
}

function summarizePages(pages) {
  return {
    endpoint: "/api/v1/info/get_rank_list",
    requestedSort: "成交量",
    available: pages.some((page) => page.ok),
    pages: pages.map((page) => ({
      label: page.label, pageIndex: page.pageIndex, ok: page.ok,
      httpStatus: page.httpStatus, businessCode: page.businessCode, message: page.message,
      currentPage: page.currentPage, total: page.total, dataLength: page.dataLength,
      itemKeys: page.itemKeys, firstThree: page.firstThree, responseTimeFields: page.responseTimeFields,
    })),
    totalRowsInspected: pages.reduce((sum, page) => sum + page.dataLength, 0),
  };
}

function toRankRow(item) {
  return {
    id: finiteNumber(item.id),
    goodId: finiteNumber(item.good_id ?? item.goodId),
    marketHashName: text(item.market_hash_name ?? item.marketHashName ?? item.name),
    rankNum: finiteNumber(item.rank_num ?? item.rankNum),
    rankNumChange: finiteNumber(item.rank_num_change ?? item.rankNumChange),
    statistic: safeStatistic(item.statistic),
    turnoverNumber: finiteNumber(item.turnover_number ?? item.turnoverNumber ?? item.volume),
    buffSellNum: finiteNumber(item.buff_sell_num ?? item.buffSellNum),
    yyypSellNum: finiteNumber(item.yyyp_sell_num ?? item.yyypSellNum),
    buffBuyNum: finiteNumber(item.buff_buy_num ?? item.buffBuyNum),
    yyypBuyNum: finiteNumber(item.yyyp_buy_num ?? item.yyypBuyNum),
    createdAt: text(item.created_at ?? item.createdAt),
    updatedAt: text(item.updated_at ?? item.updatedAt ?? item.update_time ?? item.updateTime),
    periodAt: text(item.period_at ?? item.periodAt ?? item.data_time ?? item.dataTime),
  };
}

function toSafeRow(item) {
  const row = toRankRow(item);
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value != null));
}

function findRows(value, depth = 0) {
  if (depth > 4 || value == null) return [];
  if (Array.isArray(value) && value.every((item) => item && typeof item === "object")) return value;
  const record = asRecord(value);
  for (const key of ["list", "rows", "items", "goods", "goods_list", "data_list", "records", "result"]) {
    const found = findRows(record[key], depth + 1);
    if (found.length) return found;
  }
  for (const candidate of Object.values(record)) {
    const found = findRows(candidate, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function collectTimeFields(rows) {
  const candidates = new Set();
  for (const item of rows) for (const key of Object.keys(item)) if (/(?:created|updated|period|timestamp|data_time|update_time)/i.test(key)) candidates.add(key);
  return [...candidates].sort();
}

function hasAllRequiredMatches(pages, required) {
  const ids = new Set(pages.flatMap((page) => page.rows ?? []).map((row) => row.goodId).filter(Boolean));
  return required.every((item) => ids.has(item.goodId));
}

function matchStageA(rows, required) {
  return required.map((item) => {
    const rank = rows.find((row) => row.goodId === item.goodId || (row.marketHashName && row.marketHashName === item.marketHashName)) ?? null;
    return { ...item, rank: rank ? {
      position: rows.indexOf(rank) + 1,
      rankNum: rank.rankNum,
      rankNumChange: rank.rankNumChange,
      turnoverNumber: rank.turnoverNumber,
      buffSellNum: rank.buffSellNum,
      yyypSellNum: rank.yyypSellNum,
      buffBuyNum: rank.buffBuyNum,
      yyypBuyNum: rank.yyypBuyNum,
      dataTime: rank.updatedAt ?? rank.periodAt ?? rank.createdAt,
    } : null };
  });
}

function compareRankNums(volumeRows, sellRows) {
  const comparisons = [];
  for (const volume of volumeRows) {
    const sell = sellRows.find((row) => (row.goodId && row.goodId === volume.goodId) || (!row.goodId && row.id === volume.id));
    if (sell) comparisons.push({ goodId: volume.goodId, marketHashName: volume.marketHashName, volumeRankNum: volume.rankNum, sellQuantityRankNum: sell.rankNum, changed: volume.rankNum != null && sell.rankNum != null ? volume.rankNum !== sell.rankNum : null });
  }
  return {
    matchedItems: comparisons.length,
    changedItems: comparisons.filter((item) => item.changed === true).length,
    samples: comparisons.slice(0, 10),
    semantic: comparisons.some((item) => item.changed === true) ? "LIKELY_CURRENT_SORT_POSITION" : "UNKNOWN",
  };
}

function determineFreshness(pages) {
  const timeFields = [...new Set(pages.flatMap((page) => page.responseTimeFields ?? []))];
  const observedTimes = pages.flatMap((page) => page.rows ?? []).flatMap((row) => [row.updatedAt, row.periodAt, row.createdAt]).filter(Boolean);
  return { grade: observedTimes.length ? "REQUIRES_TIMESTAMP_EVALUATION" : "UNKNOWN", timeFields, observedTimes: observedTimes.slice(0, 10) };
}

async function waitForTurn() {
  const waitMs = Math.max(0, lastRequestAt + minIntervalMs - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function parseRecord(value) { try { return asRecord(JSON.parse(String(value ?? "{}"))); } catch { return {}; } }
function finiteNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function text(value) { const result = String(value ?? "").trim(); return result || null; }
function safeStatistic(value) { return typeof value === "number" && Number.isFinite(value) ? value : text(value); }
function sanitize(value) { return value ? value.replaceAll(token, "[REDACTED]").slice(0, 300) : null; }
