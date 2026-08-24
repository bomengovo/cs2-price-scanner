import { environmentSettings } from "./config";
import { domesticDataToPrices, getCSQAQMarketData } from "./csqaq";
import { getLastScan, getStoredSettings, updateSavedDomesticPrices } from "./db";
import { getServerSecret } from "./env";
import { getBuffUrl, getYoupinUrl } from "./platform-links";
import { calculateComparison } from "./pricing";
import { getSteamDTPrices } from "./steamdt";
import type { AppSettings, PlatformPrice, ScanResult } from "./types";
import { flushApiUsage } from "./rate-limit/api-usage";

export async function refreshSavedPrices(signal?: AbortSignal, maxItems?: number): Promise<{
  results: ScanResult[]; updated: number; provider: "csqaq" | "steamdt" | "steamdt-fallback"; csqaqBatchRequests: number; steamdtBatchRequests: number; warnings: string[];
}> {
  const sessionId = crypto.randomUUID();
  try { return await refreshSavedPricesSession(signal, sessionId, maxItems); }
  finally { flushApiUsage(sessionId); }
}

async function refreshSavedPricesSession(signal: AbortSignal | undefined, sessionId: string, maxItems?: number): Promise<{
  results: ScanResult[]; updated: number; provider: "csqaq" | "steamdt" | "steamdt-fallback"; csqaqBatchRequests: number; steamdtBatchRequests: number; warnings: string[];
}> {
  const saved = getLastScan();
  if (!saved?.results.length) throw new Error("没有可刷新的已保存商品");
  const settings = { ...environmentSettings(), ...getStoredSettings() } as AppSettings;
  const allNames = [...new Set(saved.results.map((item) => item.marketHashName))];
  const names = Number.isFinite(maxItems) && Number(maxItems) > 0 ? allNames.slice(0, Math.floor(Number(maxItems))) : allNames;
  const warnings: string[] = [];
  let prices = new Map<string, PlatformPrice[]>();
  let provider: "csqaq" | "steamdt" | "steamdt-fallback" = "csqaq";
  let csqaqBatchRequests = 0;
  let steamdtBatchRequests = 0;
  let csqaqSucceeded = false;
  const token = getServerSecret("CSQAQ_API_TOKEN");
  if (settings.domesticProvider !== "steamdt" && token) {
    try {
      const response = await getCSQAQMarketData({ marketHashNames: names, apiToken: token, cacheMinutes: settings.priceCacheMinutes, forceRefresh: true, signal, sessionId });
      prices = domesticDataToPrices(response.data);
      csqaqBatchRequests = response.batchRequests;
      csqaqSucceeded = true;
    } catch (error) { warnings.push(`${error instanceof Error ? error.message : "CSQAQ 刷新失败"}，已切换 SteamDT 整体备用。`); }
  } else if (settings.domesticProvider !== "steamdt") warnings.push("CSQAQ Token 未配置，本次价格刷新使用 SteamDT 整体备用。");
  if (!csqaqSucceeded) {
    const apiKey = getServerSecret("STEAMDT_API_KEY");
    if (!apiKey) throw new Error("CSQAQ 不可用且未配置 STEAMDT_API_KEY");
    provider = settings.domesticProvider === "steamdt" ? "steamdt" : "steamdt-fallback";
    const response = await getSteamDTPrices({ marketHashNames: names, apiKey, settings, forceRefresh: true, signal, sessionId });
    prices = response.prices;
    steamdtBatchRequests = response.fetched > 0 ? 1 : 0;
  }
  const refreshed = saved.results.map((item) => applyPrices(item, prices.get(item.marketHashName) ?? []));
  const changed = refreshed.filter((item, index) => item !== saved.results[index]);
  updateSavedDomesticPrices(changed);
  return { results: getLastScan()?.results ?? refreshed, updated: changed.length, provider, csqaqBatchRequests, steamdtBatchRequests, warnings };
}

function applyPrices(item: ScanResult, values: PlatformPrice[]): ScanResult {
  if (!values.length) return item;
  const buff = values.filter((value) => value.platform === "buff").sort((a, b) => a.sellPrice - b.sellPrice)[0] ?? item.buff;
  const youpin = values.filter((value) => value.platform === "youpin").sort((a, b) => a.sellPrice - b.sellPrice)[0] ?? item.youpin;
  const buffGoodsId = buff?.platformItemId ?? item.buffGoodsId;
  const youpinTemplateId = youpin?.platformItemId ?? item.youpinTemplateId;
  return calculateComparison({ ...item, buff, youpin, buffGoodsId, youpinTemplateId,
    platformIds: { buff: buffGoodsId, youpin: youpinTemplateId },
    buffUrl: getBuffUrl(buffGoodsId, item.marketHashName), youpinUrl: getYoupinUrl(youpinTemplateId, item.marketHashName),
    dataUpdatedAt: Math.max(buff?.updatedAt ?? 0, youpin?.updatedAt ?? 0, Date.now()),
    snapshotStatus: !buff && !youpin ? "unavailable" : buff?.status === "stale" || youpin?.status === "stale" ? "partial" : "live" });
}
