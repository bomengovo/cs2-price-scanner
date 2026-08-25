import { getBaseItem, getCachedDomesticMarketData, getCsqaqItemMetadata, saveCsqaqItemMetadata, saveDomesticMarketData } from "./db";
import { getCsqaqHeaders } from "./env";
import { fetchWithRetry } from "./http";
import { roundMoney } from "./pricing";
import { recordApiUsage } from "./rate-limit/api-usage";
import { scheduleCsqaqBatch, scheduleCsqaqRequest } from "./rate-limit/csqaq-scheduler";
import { assertCsqaqAuthAvailable, withCsqaqAuthRecovery } from "./csqaq-ip-binding";
import type { CsqaqItemMetadata, DomesticMarketData, PlatformPrice } from "./types";
import { unavailableVolume, getShanghaiDayRange, type DailyVolumeResult } from "./volume/types";

const endpoint = "https://api.csqaq.com/api/v1/goods/getPriceByMarketHashName";
const detailEndpoint = "https://api.csqaq.com/api/v1/info/good";
const chartEndpoint = "https://api.csqaq.com/api/v1/info/chart";
export const CSQAQ_METADATA_TTL_MS = 6 * 60 * 60 * 1000;

export async function getCSQAQMarketData(options: { marketHashNames: string[]; apiToken: string; cacheMinutes: number; forceRefresh?: boolean; signal?: AbortSignal; sessionId?: string }): Promise<{ data: Map<string, DomesticMarketData>; batchRequests: number; matched: number }> {
  const names = [...new Set(options.marketHashNames.filter(Boolean))];
  const cache = getCachedDomesticMarketData(names, Math.max(1, options.cacheMinutes) * 60_000);
  const missing = options.forceRefresh ? names : names.filter((name) => !cache.has(name));
  let batchRequests = 0;
  if (missing.length) {
    assertCsqaqAuthAvailable();
    const fresh: DomesticMarketData[] = [];
    const chunks = chunkMarketHashNames(missing);
    for (let index = 0; index < chunks.length; index += 1) {
      const startedAt = Date.now();
      const names = chunks[index];
      const response = await scheduleCsqaqBatch({ key: names.join("\u0000"), signal: options.signal, run: () => withCsqaqAuthRecovery(() => fetchWithRetry(endpoint, { method: "POST", headers: getCsqaqHeaders(options.apiToken), body: JSON.stringify({ marketHashNameList: names }) }, { signal: options.signal, retries: 0, timeoutMs: 20_000 })) });
      batchRequests += 1;
      if (options.sessionId) recordApiUsage(options.sessionId, "csqaq-batch", { status: response.status, names: names.length, durationMs: Date.now() - startedAt });
      const body = await response.json() as { code?: number; msg?: string; data?: { success?: Record<string, unknown> } };
      if (body.code !== 200 || !body.data?.success) throw new Error(`CSQAQ 请求失败：${body.msg || body.code || "响应结构异常"}`);
      for (const [name, raw] of Object.entries(body.data.success)) fresh.push(normalizeCSQAQItem(name, raw));
    }
    saveDomesticMarketData(fresh);
    for (const item of fresh) cache.set(item.marketHashName, item);
  }
  return { data: cache, batchRequests, matched: [...cache.values()].filter((item) => item.buff.sellPrice != null || item.yyyp.sellPrice != null).length };
}

export function normalizeCSQAQItem(fallbackName: string, raw: unknown): DomesticMarketData {
  const value = raw as Record<string, unknown>;
  const marketHashName = String(value.marketHashName ?? fallbackName).trim();
  if (!marketHashName) throw new Error("CSQAQ 返回空 marketHashName");
  return { marketHashName, goodId: finite(value.goodId),
    buff: { sellPrice: money(value.buffSellPrice), buyPrice: money(value.buffBuyPrice), sellCount: finite(value.buffSellNum), buyCount: finite(value.buffBuyNum) },
    yyyp: { sellPrice: money(value.yyypSellPrice), buyPrice: money(value.yyypBuyPrice), sellCount: finite(value.yyypSellNum), buyCount: finite(value.yyypBuyNum) },
    source: "CSQAQ_LIVE", fetchedAt: Date.now() };
}

export async function getCSQAQItemMetadata(options: {
  marketHashName: string; goodId?: number | null; apiToken?: string; signal?: AbortSignal; sessionId?: string; forceRefresh?: boolean;
}): Promise<CsqaqItemMetadata | null> {
  const cached = getCsqaqItemMetadata(options.marketHashName);
  const goodId = Number(options.goodId ?? cached?.csqaqGoodId);
  if (!Number.isFinite(goodId) || goodId <= 0) return cached;
  if (!options.forceRefresh && isCsqaqMetadataFresh(cached)) return cached;
  const startedAt = Date.now();
  assertCsqaqAuthAvailable();
  const response = await scheduleCsqaqRequest({
    key: String(goodId), kind: "CSQAQ_INFO_GOOD", priority: "low", signal: options.signal,
    run: () => withCsqaqAuthRecovery(() => fetchWithRetry(`${detailEndpoint}?id=${encodeURIComponent(goodId)}`, {
      method: "GET", headers: getCsqaqHeaders(options.apiToken),
    }, { signal: options.signal, retries: 0, timeoutMs: 20_000 })),
  });
  if (options.sessionId) recordApiUsage(options.sessionId, "csqaq-detail", { status: response.status, durationMs: Date.now() - startedAt });
  const body = await response.json() as { code?: number; data?: unknown };
  if (body.code !== 200) return cached;
  const root = asRecord(body.data);
  const info = asRecord(root.goods_info ?? root.good_info ?? root);
  const name = String(info.market_hash_name ?? info.marketHashName ?? root.market_hash_name ?? "").trim();
  if (name && name !== options.marketHashName) return cached;
  const metadata: CsqaqItemMetadata = {
    marketHashName: options.marketHashName,
    csqaqGoodId: goodId,
    buffGoodsId: identifier(info.buff_id ?? info.buffId),
    youpinTemplateId: identifier(info.yyyp_id ?? info.yyypId),
    itemType: optionalText(info.type_name ?? info.type),
    turnoverNumber: nonNegativeInteger(info.turnover_number ?? info.turnoverNumber),
    turnoverAvgPrice: nonNegativeNumber(info.turnover_avg_price ?? info.turnoverAvgPrice),
    periodAt: optionalText(info.period_at ?? info.periodAt),
    fetchedAt: Date.now(), updatedAt: Date.now(),
  };
  saveCsqaqItemMetadata(metadata);
  return metadata;
}

export function isCsqaqMetadataFresh(metadata: CsqaqItemMetadata | null | undefined, now = Date.now()): boolean {
  return Boolean(metadata?.fetchedAt && metadata.fetchedAt >= now - CSQAQ_METADATA_TTL_MS);
}

/**
 * Fetch the real daily volume from CSQAQ /info/chart.
 *
 * Returns the most recent day's turnover_number for the given item and
 * platform (1 = BUFF, 2 = 悠悠有品).  Uses a 30-day window and takes the
 * last element of the returned daily time-series.
 */
export async function getCSQAQDailyVolume(options: {
  marketHashName: string; goodId: number; platform: "buff" | "youpin";
  apiToken?: string; signal?: AbortSignal; sessionId?: string;
}): Promise<DailyVolumeResult> {
  const chartPlatform = options.platform === "buff" ? 1 : 2;
  const startedAt = Date.now();
  const response = await scheduleCsqaqRequest({
    key: `${options.goodId}:chart:${chartPlatform}`,
    kind: "CSQAQ_INFO_CHART",
    priority: "low",
    signal: options.signal,
    run: () => withCsqaqAuthRecovery(() => fetchWithRetry(chartEndpoint, {
      method: "POST",
      headers: getCsqaqHeaders(options.apiToken),
      body: JSON.stringify({
        good_id: String(options.goodId),
        key: "turnover_number",
        platform: chartPlatform,
        period: "30",
        style: "all_style",
      }),
    }, { signal: options.signal, retries: 0, timeoutMs: 20_000 })),
  });
  if (options.sessionId) recordApiUsage(options.sessionId, "csqaq-chart", { status: response.status, durationMs: Date.now() - startedAt });
  const body = await response.json() as { code?: number; data?: { timestamp?: number[]; num_data?: number[] } };
  if (body.code !== 200 || !body.data?.timestamp?.length || !body.data?.num_data?.length) {
    return { ...unavailableVolume(options.marketHashName, options.platform, "csqaq-chart-empty"), goodId: options.goodId, status: "unavailable" };
  }
  const lastIndex = body.data.timestamp.length - 1;
  const lastTimestamp = body.data.timestamp[lastIndex]!;
  const lastVolume = body.data.num_data[lastIndex];
  const chartDate = new Date(lastTimestamp * 1000).toISOString().split("T")[0]!;
  return {
    marketHashName: options.marketHashName,
    platform: options.platform,
    goodId: options.goodId,
    volume: lastVolume ?? null,
    date: getShanghaiDayRange().date,
    source: `csqaq-chart:${chartDate}`,
    fetchedAt: Date.now(),
    status: "live",
  };
}

export function domesticDataToPrices(data: Map<string, DomesticMarketData>): Map<string, PlatformPrice[]> {
  const output = new Map<string, PlatformPrice[]>();
  for (const item of data.values()) {
    const base = getBaseItem(item.marketHashName);
    const prices: PlatformPrice[] = [];
    if (item.buff.sellPrice != null) prices.push(toPrice(item, "buff", item.buff, base?.buffGoodsId ?? null));
    if (item.yyyp.sellPrice != null) prices.push(toPrice(item, "youpin", item.yyyp, base?.youpinTemplateId ?? null));
    output.set(item.marketHashName, prices);
  }
  return output;
}

function toPrice(item: DomesticMarketData, platform: "buff" | "youpin", data: DomesticMarketData["buff"], platformItemId: string | null): PlatformPrice {
  return { marketHashName: item.marketHashName, platform, rawPlatform: platform === "buff" ? "BUFF" : "YOUPIN", platformItemId,
    sellPrice: data.sellPrice!, sellCount: data.sellCount ?? 0, bidPrice: data.buyPrice ?? null, bidCount: data.buyCount ?? 0,
    updatedAt: item.fetchedAt, fetchedAt: item.fetchedAt, source: item.source === "CSQAQ_CACHE" ? "csqaq-cache" : "csqaq-live", status: item.source === "CSQAQ_CACHE" ? "cache" : "live" };
}

function money(value: unknown): number | undefined { const number = Number(value); return Number.isFinite(number) && number >= 0 ? roundMoney(number) : undefined; }
function finite(value: unknown): number | undefined { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : undefined; }
function nonNegativeInteger(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null; }
function nonNegativeNumber(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function identifier(value: unknown): string | null { const text = String(value ?? "").trim(); return text && text !== "0" ? text : null; }
function optionalText(value: unknown): string | null { const text = String(value ?? "").trim(); return text || null; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function chunkMarketHashNames(items: string[]): string[][] {
  return Array.from({ length: Math.ceil(items.length / 50) }, (_, index) => items.slice(index * 50, (index + 1) * 50));
}
