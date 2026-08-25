import { environmentSettings } from "./config";
import { fetchCSFloatListings } from "./csfloat";
import { getBaseItem, getCachedDailyVolumes, getCsqaqItemMetadata, getLastScan, getLatestCsfloatSnapshot, getStoredSettings, saveCsfloatSnapshot, saveScanResults, saveScanSessionMetrics } from "./db";
import { buildItemImageCandidates, categorizeItem } from "./items";
import { mockChineseNames, mockListings, mockPrices } from "./mock";
import { getBuffUrl, getCsfloatUrl, getYoupinUrl, validatePlatformLinks } from "./platform-links";
import { calculateComparison, centsToUsd, usdToCny } from "./pricing";
import { getSteamDTPrices } from "./steamdt";
import { domesticDataToPrices, getCSQAQDailyVolume, getCSQAQMarketData } from "./csqaq";
import { getShanghaiDayRange } from "./volume/types";
import { flushApiUsage } from "./rate-limit/api-usage";
import type { AppSettings, CSFloatListing, PlatformPrice, ScanProgress, ScanRequest, ScanResult, ScanSessionState } from "./types";
import fs from "node:fs";
import path from "node:path";
import { getServerSecret } from "./env";
import { startCsqaqBindPreflight } from "./csqaq-ip-binding";
import { startCsfloatNetworkMonitor } from "./csfloat-network";

export interface ScanOutput { results: ScanResult[]; scannedAt: number; settings: AppSettings; warnings: string[]; merge: { discovered: number; added: number; updated: number; retained: number; deletedSkipped: number }; domestic: { provider: "mock" | "csqaq" | "steamdt-fallback" | "steamdt"; csqaqBatchRequests: number; steamdtBatchRequests: number; matched: number }; session: ScanSessionState }

export async function runScan(
  request: ScanRequest,
  onProgress: (progress: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<ScanOutput> {
  const scanSessionId = crypto.randomUUID();
  try { return await runScanSession(request, onProgress, signal, scanSessionId); }
  finally { flushApiUsage(scanSessionId); }
}

async function runScanSession(request: ScanRequest, onProgress: (progress: ScanProgress) => void, signal: AbortSignal | undefined, scanSessionId: string): Promise<ScanOutput> {
  const sessionStartedAt = Date.now();
  const settings = { ...environmentSettings(), ...getStoredSettings() } as AppSettings;
  // Mock scans must stay fully offline.  In particular, they must never retain
  // a real IP-binding flight that could interfere with a later authenticated scan.
  if (!settings.mockMode) {
    startCsqaqBindPreflight();
    startCsfloatNetworkMonitor();
  }
  const warnings: string[] = [];
  logScanStage(scanSessionId, "SCAN_START", { limit: request.limit, forceRefresh: request.forceRefresh });
  const allowedLimit = request.limit === "all" ? "all" : Math.min(Math.max(request.limit, 1), settings.maxScanCount);
  const progress: ScanProgress = { phase: "csfloat", percent: 5, fetchedListings: 0, uniqueItems: 0, matchedItems: 0, qualifiedItems: 0, buffComparable: 0, youpinComparable: 0, status: settings.mockMode ? "正在读取测试数据" : "正在连接 CSFloat" };
  onProgress(progress);
  let csfloatSource: "live" | "cache" | "mock" = settings.mockMode ? "mock" : "live";
  let csfloatFetchedAt = Date.now();
  let discoveredListings: CSFloatListing[];
  if (settings.mockMode) discoveredListings = mockListings(allowedLimit);
  else try {
    logScanStage(scanSessionId, "CSFLOAT_FETCH_START", { limit: allowedLimit });
    discoveredListings = await fetchCSFloatListings({ limit: allowedLimit, maxSafePages: settings.maxSafePages, apiKey: process.env.CSFLOAT_API_KEY, signal, sessionId: scanSessionId, onPage: (pageItems, page) => {
      progress.fetchedListings += pageItems.length;
      progress.percent = Math.min(40, page === 1 ? 20 : 35 + (page - 2) * 5);
      progress.status = `CSFloat 第 ${page} 页完成，已取得 ${progress.fetchedListings} 条`;
      onProgress({ ...progress });
    } });
    csfloatFetchedAt = saveCsfloatSnapshot(scanSessionId, discoveredListings);
    logScanStage(scanSessionId, "CSFLOAT_FETCH_SUCCESS", { listings: discoveredListings.length });
  } catch (error) {
    const snapshot = getLatestCsfloatSnapshot();
    if (!snapshot) throw error;
    discoveredListings = snapshot.listings.slice(0, allowedLimit === "all" ? undefined : allowedLimit);
    csfloatSource = "cache";
    csfloatFetchedAt = snapshot.fetchedAt;
    warnings.push(`${error instanceof Error ? error.message : "CSFloat 不可用"} 当前展示上次 CSFloat Snapshot。`);
    progress.status = "正在读取 CSFloat Cache";
    onProgress({ ...progress });
  }
  if (!discoveredListings.length) throw new Error("CSFloat 实时最低价获取失败，未生成扫描结果");
  const listings = selectBestListings(discoveredListings);
  progress.fetchedListings = discoveredListings.length;
  const names = [...new Set(listings.map((item) => item.marketHashName))];
  logScanStage(scanSessionId, "CSFLOAT_NORMALIZED", { rawListings: listings.length, validListings: listings.length, uniqueMarketHashNames: names.length, sampleNames: names.slice(0, 5) });
  progress.uniqueItems = names.length;
  progress.phase = "domestic";
  progress.percent = 45;
  progress.status = settings.mockMode ? "正在匹配测试价格" : "正在查询国内市场价格";
  onProgress({ ...progress });
  let prices: Map<string, PlatformPrice[]> = settings.mockMode ? mockPrices(names) : new Map<string, PlatformPrice[]>();
  const domestic: ScanOutput["domestic"] = { provider: settings.mockMode ? "mock" : "csqaq", csqaqBatchRequests: 0, steamdtBatchRequests: 0, matched: 0 };
  logScanStage(scanSessionId, "DOMESTIC_PROVIDER_SELECTED", { provider: domestic.provider, requestedNames: names.length });
  if (!settings.mockMode) {
    let csqaqSucceeded = false;
    const csqaqToken = getServerSecret("CSQAQ_API_TOKEN");
    if (settings.domesticProvider !== "steamdt" && csqaqToken) {
      try {
        logScanStage(scanSessionId, "CSQAQ_BATCH_QUEUED", { requestedNames: names.length });
        const response = await getCSQAQMarketData({ marketHashNames: names, apiToken: csqaqToken, cacheMinutes: settings.priceCacheMinutes, forceRefresh: request.forceRefresh, signal, sessionId: scanSessionId });
        prices = domesticDataToPrices(response.data);
        domestic.csqaqBatchRequests = response.batchRequests;
        domestic.matched = response.matched;
        csqaqSucceeded = true;
        logScanStage(scanSessionId, "CSQAQ_BATCH_SUCCESS", { batches: response.batchRequests, matchedNames: response.matched });
      } catch (error) { logScanStage(scanSessionId, "CSQAQ_BATCH_FAILED", { error: error instanceof Error ? error.message : "unknown" }); warnings.push(`${error instanceof Error ? error.message : "CSQAQ 价格获取失败"}，已切换 SteamDT 整体备用。`); }
    } else if (settings.domesticProvider !== "steamdt") warnings.push("CSQAQ Token 未配置，本轮使用 SteamDT 整体备用。");
    if (!csqaqSucceeded) {
      const apiKey = getServerSecret("STEAMDT_API_KEY");
      if (!apiKey) throw new Error("CSQAQ 不可用且未配置 STEAMDT_API_KEY");
      domestic.provider = settings.domesticProvider === "steamdt" ? "steamdt" : "steamdt-fallback";
      try {
        logScanStage(scanSessionId, "STEAMDT_FALLBACK_START", { requestedNames: names.length });
        const response = await getSteamDTPrices({ marketHashNames: names, apiKey, settings, forceRefresh: request.forceRefresh, signal, sessionId: scanSessionId });
        prices = new Map([...response.prices].map(([name, values]) => [name, values.map((value) => ({ ...value, source: "steamdt-fallback" as const }))]));
        domestic.steamdtBatchRequests = response.fetched > 0 ? 1 : 0;
        logScanStage(scanSessionId, "STEAMDT_FALLBACK_SUCCESS", { batches: domestic.steamdtBatchRequests, matchedNames: [...prices.values()].filter((value) => value.length > 0).length });
      } catch (error) { warnings.push(error instanceof Error ? error.message : "SteamDT 价格获取失败"); prices = new Map(); }
    }
  }
  // Auto-fill daily volume from CSQAQ chart API for all unique items.
  // Fire-and-forget so the scan never hangs waiting for 100+ chart requests.
  const csqaqToken = getServerSecret("CSQAQ_API_TOKEN");
  if (!settings.mockMode && csqaqToken) {
    void autoFillDailyVolumes(names, csqaqToken, signal, scanSessionId);
  }
  progress.matchedItems = [...prices.values()].filter((value) => value.length > 0).length;
  domestic.matched = progress.matchedItems;
  logScanStage(scanSessionId, domestic.provider === "csqaq" ? "CSQAQ_MATCHED" : "STEAMDT_MATCHED", { requestedNames: names.length, matchedNames: progress.matchedItems });
  progress.buffComparable = [...prices.values()].filter((value) => value.some((price) => price.platform === "buff")).length;
  progress.youpinComparable = [...prices.values()].filter((value) => value.some((price) => price.platform === "youpin")).length;
  progress.phase = "compare";
  progress.percent = 95;
  progress.status = "正在计算价差";
  onProgress({ ...progress });
  const results = listings.map((listing) => toScanResult(listing, prices.get(listing.marketHashName) ?? [], settings, scanSessionId, csfloatSource, csfloatFetchedAt));
  logScanStage(scanSessionId, "FINAL_ROWS", { rows: results.length });
  logImageDiagnostics(results);
  logPlatformLinkDiagnostics(results);
  progress.qualifiedItems = results.filter((result) => (result.bestDiff ?? 0) > 0).length;
  progress.phase = "done";
  progress.percent = 100;
  progress.status = warnings.length ? "扫描完成，部分平台数据不可用" : "扫描完成";
  onProgress({ ...progress });
  const merge = saveScanResults(results, scanSessionId, settings.mockMode ? "mock" : "live");
  logScanStage(scanSessionId, "RESULTS_MERGED", merge.stats);
  const session: ScanSessionState = {
    scanStartedAt: sessionStartedAt,
    scanFinishedAt: Date.now(),
    csfloatProvider: csfloatSource === "cache" ? "SNAPSHOT" : csfloatSource === "mock" ? "MOCK" : "LIVE",
    domesticProvider: domestic.provider === "csqaq" ? (domestic.csqaqBatchRequests > 0 ? "CSQAQ" : "CACHE") : domestic.provider === "steamdt-fallback" ? "STEAMDT_FALLBACK" : domestic.provider === "steamdt" ? "STEAMDT" : "MOCK",
    csfloatFetchedAt,
    domesticFetchedAt: Math.max(...[...prices.values()].flat().map((price) => price.fetchedAt ?? price.updatedAt ?? 0), 0) || null,
    savedAt: merge.scannedAt,
  };
  saveScanSessionMetrics(scanSessionId, merge.scannedAt, progress, session);
  const saved = getLastScan();
  logScanStage(scanSessionId, "SCAN_COMPLETE", { listings: discoveredListings.length, uniqueMarketHashNames: names.length, csqaqBatchRequests: domestic.csqaqBatchRequests, csqaqMatched: domestic.provider === "csqaq" ? domestic.matched : 0, steamdtBatchRequests: domestic.steamdtBatchRequests, steamdtMatched: domestic.provider === "csqaq" ? 0 : domestic.matched, savedTotal: saved?.results.length ?? results.length, positiveOpportunities: progress.qualifiedItems, durationMs: Date.now() - sessionStartedAt });
  return { results: saved?.results ?? results, scannedAt: merge.scannedAt, settings, warnings, merge: { discovered: discoveredListings.length, ...merge.stats }, domestic, session };
}

export function selectBestListings(listings: CSFloatListing[]): CSFloatListing[] {
  const best = new Map<string, CSFloatListing>();
  for (const listing of listings) {
    const current = best.get(listing.marketHashName);
    if (!current || compareListingValue(listing, current) < 0) best.set(listing.marketHashName, listing);
  }
  return [...best.values()];
}

function compareListingValue(left: CSFloatListing, right: CSFloatListing): number {
  if (left.price !== right.price) return left.price - right.price;
  const leftFloat = left.floatValue ?? Number.POSITIVE_INFINITY;
  const rightFloat = right.floatValue ?? Number.POSITIVE_INFINITY;
  if (leftFloat !== rightFloat) return leftFloat - rightFloat;
  return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
}

function toScanResult(listing: CSFloatListing, platformPrices: import("./types").PlatformPrice[], settings: AppSettings, scanSessionId: string, csfloatSource: "live" | "cache" | "mock", csfloatFetchedAt: number): ScanResult {
  const buff = platformPrices.filter((price) => price.platform === "buff").sort((a, b) => a.sellPrice - b.sellPrice)[0] ?? null;
  const youpin = platformPrices.filter((price) => price.platform === "youpin").sort((a, b) => a.sellPrice - b.sellPrice)[0] ?? null;
  const base = getBaseItem(listing.marketHashName);
  const metadata = getCsqaqItemMetadata(listing.marketHashName);
  const csfloatListingId = /^\d+$/.test(listing.id) ? listing.id : null;
  const buffGoodsId = metadata?.buffGoodsId ?? buff?.platformItemId ?? base?.buffGoodsId ?? null;
  const youpinTemplateId = metadata?.youpinTemplateId ?? youpin?.platformItemId ?? base?.youpinTemplateId ?? null;
  if (buff && !buffGoodsId) logIntegrity("PLATFORM_ID_MISSING", listing.marketHashName, buff.rawPlatform, buff.platformItemId);
  if (youpin && !youpinTemplateId) logIntegrity("PLATFORM_ID_MISSING", listing.marketHashName, youpin.rawPlatform, youpin.platformItemId);
  const usd = centsToUsd(listing.price);
  const imageUrls = buildItemImageCandidates(...(listing.imageUrls ?? []), listing.iconUrl, base?.imageUrl);
  // Check daily_volume_cache for chart data (populated by the enrichment flow)
  const volumeDate = getShanghaiDayRange().date;
  const volumeCache = getCachedDailyVolumes([listing.marketHashName], volumeDate, 86_400_000);
  const buffVolume = volumeCache.get(`${listing.marketHashName}:buff`)?.volume ?? null;
  const uuVolume = volumeCache.get(`${listing.marketHashName}:youpin`)?.volume ?? null;
  const buffVolumeSource = volumeCache.get(`${listing.marketHashName}:buff`)?.source ?? null;
  const uuVolumeSource = volumeCache.get(`${listing.marketHashName}:youpin`)?.source ?? null;
  const hasChartVolume = buffVolumeSource?.startsWith("csqaq-chart") || uuVolumeSource?.startsWith("csqaq-chart");
  const totalDailyVolume = buffVolume != null && uuVolume != null ? buffVolume + uuVolume : (buffVolume ?? uuVolume ?? null);
  const volumeCoverage = hasChartVolume ? (buffVolume != null && uuVolume != null ? "complete" : "partial") : "none";
  return calculateComparison({
    ...listing,
    listingUrl: getCsfloatUrl(csfloatListingId, listing.marketHashName)!,
    iconUrl: imageUrls[0] ?? "",
    imageUrls,
    chineseName: settings.mockMode ? (mockChineseNames.get(listing.marketHashName) ?? listing.itemName) : (base?.name ?? listing.itemName),
    category: categorizeItem(listing.marketHashName),
    csfloatUsd: usd,
    csfloatCny: usdToCny(usd, settings.usdCnyRate),
    buff,
    youpin,
    csfloatListingId,
    csqaqGoodId: metadata?.csqaqGoodId ?? null,
    buffGoodsId,
    youpinTemplateId,
    platformIds: { buff: buffGoodsId, youpin: youpinTemplateId },
    csqaqDailyVolume: metadata?.turnoverNumber ?? null,
    csqaqVolumePeriodAt: metadata?.periodAt ?? null,
    csqaqVolumeFetchedAt: metadata?.fetchedAt ?? null,
    csqaqVolumeSource: metadata?.fetchedAt ? "csqaq-info-good" : null,
    csfloatDailyVolume: null,
    buffDailyVolume: buffVolume,
    uuDailyVolume: uuVolume,
    totalDailyVolume,
    volumeCoverage,
    buffUrl: getBuffUrl(buffGoodsId, listing.marketHashName),
    youpinUrl: getYoupinUrl(youpinTemplateId, listing.marketHashName),
    dataUpdatedAt: Math.max(buff?.updatedAt ?? 0, youpin?.updatedAt ?? 0, Date.now()),
    scanSessionId,
    snapshotStatus: csfloatSource === "cache" || buff?.status === "stale" || youpin?.status === "stale"
      ? "partial"
      : !buff && !youpin ? "unavailable" : "live",
    csfloatFetchedAt,
    csfloatSource,
  });
}

function logIntegrity(code: string, marketHashName: string, platform?: string, platformItemId?: string | null): void {
  try {
    const directory = path.join(process.cwd(), "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "data-integrity.log"), `${new Date().toISOString()} ${code} ${JSON.stringify({ marketHashName, platform, platformItemId })}\n`, "utf8");
  } catch { /* diagnostics must not interrupt a scan */ }
}

function logScanStage(sessionId: string, stage: string, details: Record<string, unknown>): void {
  try {
    const directory = path.join(process.cwd(), "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "scan-stages.log"), `${new Date().toISOString()} session=${sessionId} stage=${stage} ${JSON.stringify(details)}\n`, "utf8");
  } catch { /* diagnostics only */ }
}

function logPlatformLinkDiagnostics(results: ScanResult[]): void {
  if (process.env.NODE_ENV === "production") return;
  const validations = validatePlatformLinks(results, 10);
  console.info("[链接诊断] 前 10 个 marketHashName / 平台 ID / 最终 URL");
  for (const result of validations) {
    const item = results.find((candidate) => candidate.marketHashName === result.marketHashName)!;
    console.info("[链接诊断]", {
      marketHashName: result.marketHashName,
      buffPlatform: item.buff?.rawPlatform ?? null,
      buffPlatformItemId: item.buffGoodsId,
      youpinPlatform: item.youpin?.rawPlatform ?? null,
      youpinPlatformItemId: item.youpinTemplateId,
      urls: result.urls,
      valid: result.valid,
      errors: result.errors,
    });
  }
}

function logImageDiagnostics(results: ScanResult[]): void {
  if (process.env.NODE_ENV === "production") return;
  const distinctItems = [...new Map(results.map((result) => [result.marketHashName, result])).values()].slice(0, 10);
  console.info("[图片诊断] 前 10 个 marketHashName → imageUrl");
  for (const result of distinctItems) console.info(`[图片诊断] ${result.marketHashName} → ${result.iconUrl || "暂无图片"}`);
  const uniqueImages = new Set(distinctItems.map((result) => result.iconUrl).filter(Boolean));
  if (distinctItems.length > 1 && uniqueImages.size <= 1) console.warn("[图片诊断] 多个不同饰品复用了同一个 imageUrl，请检查上游数据");
}

/**
 * Fire-and-forget daily-volume fill for a set of market hash names. It runs in
 * the background via the CSQAQ scheduler so a scan never blocks on 100+ chart
 * requests. Results pop the daily_volume_cache; the UI picks them up on refresh.
 */
async function autoFillDailyVolumes(names: string[], apiToken: string, signal: AbortSignal | undefined, scanSessionId: string): Promise<void> {
  const candidates = names.flatMap((name) => {
    const gid = getCsqaqItemMetadata(name)?.csqaqGoodId ?? null;
    if (!gid || gid <= 0) return [];
    return [("buff" as const), ("youpin" as const)].map((platform) => ({ name, gid, platform }));
  });
  // Limit concurrency so the background queue drains at a healthy pace without
  // hammering the CSQAQ API. The global scheduler already enforces a 1.1s gap.
  const batchSize = 10;
  for (let i = 0; i < candidates.length; i += batchSize) {
    if (signal?.aborted) break;
    await Promise.allSettled(candidates.slice(i, i + batchSize).map(({ name, gid, platform }) =>
      getCSQAQDailyVolume({ marketHashName: name, goodId: gid, platform, apiToken, signal, sessionId: scanSessionId }).catch(() => null),
    ));
  }
}
