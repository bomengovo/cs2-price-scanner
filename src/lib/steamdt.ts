import { baseItemsAreFresh, getBaseItem, getCachedPrices, saveBaseItems, savePrices } from "./db";
import { ApiError, fetchWithRetry } from "./http";
import { normalizePlatform } from "./platforms";
import { defaultAliases } from "./config";
import { normalizeSteamDTPrice } from "./pricing";
import type { AppSettings, PlatformPrice } from "./types";
import { normalizeCsfloatImageUrl } from "./items";
import fs from "node:fs";
import path from "node:path";
import { scheduleSteamDTBatch } from "./rate-limit/steamdt-scheduler";
import { recordApiUsage } from "./rate-limit/api-usage";
import { getSteamDtHeaders } from "./env";

export async function ensureSteamDTBase(apiKey: string, signal?: AbortSignal): Promise<void> {
  // Base is intentionally not refreshed by scans. A future explicit mapping
  // refresh endpoint may call the implementation below.
  if (process.env.NODE_ENV !== "test" && process.env.STEAMDT_ALLOW_BASE_REFRESH !== "true") return;
  if (baseItemsAreFresh()) return;
  const response = await fetchWithRetry("https://open.steamdt.com/open/cs2/v1/base", {
    headers: getSteamDtHeaders(apiKey),
  }, { signal });
  const body = await response.json() as { success?: boolean; data?: unknown; errorMsg?: string };
  if (body.success === false) throw steamDTBodyError(body.errorMsg);
  const data = Array.isArray(body.data) ? body.data : [];
  const parsed = data.flatMap((raw) => {
    const value = raw as { name?: unknown; marketHashName?: unknown; platformList?: unknown; imageUrl?: unknown; iconUrl?: unknown; icon_url?: unknown };
    const marketHashName = String(value.marketHashName ?? "").trim();
    if (!marketHashName) return [];
    const rawImage = value.imageUrl ?? value.iconUrl ?? value.icon_url;
    const platformList = Array.isArray(value.platformList) ? value.platformList : [];
    const buffGoodsId = baseItemId(platformList, "buff");
    const youpinTemplateId = baseItemId(platformList, "youpin");
    return [{
      name: String(value.name ?? marketHashName),
      marketHashName,
      platformList,
      imageUrl: normalizeCsfloatImageUrl(typeof rawImage === "string" ? rawImage : null) || null,
      buffGoodsId,
      youpinTemplateId,
    }];
  });
  if (parsed.length) saveBaseItems(parsed);
  const actualPlatforms = new Set(parsed.flatMap((item) => item.platformList.map((entry) => String((entry as { name?: unknown }).name ?? ""))).filter(Boolean));
  logPlatforms("基础信息", [...actualPlatforms]);
}

export async function getSteamDTPrices(options: {
  marketHashNames: string[];
  apiKey: string;
  settings: AppSettings;
  forceRefresh: boolean;
  signal?: AbortSignal;
  sessionId?: string;
}): Promise<{ prices: Map<string, PlatformPrice[]>; fetched: number }> {
  const names = [...new Set(options.marketHashNames.filter(Boolean))];
  const cacheTtlMs = Math.max(1, options.settings.priceCacheMinutes) * 60_000;
  const cached = getCachedPrices(names, cacheTtlMs);
  const allFresh = names.every((name) => (cached.get(name) ?? []).some((price) => price.status === "cache"));
  if (!options.forceRefresh && allFresh) return { prices: cached, fetched: 0 };
  let fresh: PlatformPrice[] = [];
  const result = await scheduleSteamDTBatch(async () => {
    fresh = await fetchBatch(names, options.apiKey, options.settings, options.signal, options.sessionId);
    savePrices(fresh);
  });
  if (result === "cache") return { prices: cached, fetched: 0 };
  return { prices: getCachedPrices(names, cacheTtlMs), fetched: names.length };
}

async function fetchBatch(
  names: string[],
  apiKey: string,
  settings: AppSettings,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<PlatformPrice[]> {
  {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchWithRetry("https://open.steamdt.com/open/cs2/v1/price/batch", {
        method: "POST",
        headers: { ...getSteamDtHeaders(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({ marketHashNames: names }),
      }, { signal, retries: 0, timeoutMs: 20_000 });
    } catch (error) {
      if (sessionId) recordApiUsage(sessionId, "steamdt-batch", { status: error instanceof ApiError ? error.status ?? null : null, names: names.length, durationMs: Date.now() - startedAt, retryAfterMs: error instanceof ApiError ? error.retryAfterMs ?? undefined : undefined });
      throw error;
    }
    if (sessionId) recordApiUsage(sessionId, "steamdt-batch", { status: response.status, names: names.length, durationMs: Date.now() - startedAt });
    const body = await response.json() as { success?: boolean; data?: unknown; errorMsg?: string; errorCode?: number; errorCodeStr?: string };
    if (body.success === false) throw steamDTBodyError(body.errorMsg || body.errorCodeStr, body.errorCode);
    const groups = Array.isArray(body.data) ? body.data : [];
    const rawPlatforms = new Set<string>();
    const output: PlatformPrice[] = [];
    for (const group of groups) {
      const value = group as { marketHashName?: unknown; dataList?: unknown };
      const marketHashName = String(value.marketHashName ?? "").trim();
      if (!marketHashName || !Array.isArray(value.dataList)) continue;
      for (const raw of value.dataList) {
        const item = raw as Record<string, unknown>;
        const rawPlatform = String(item.platform ?? "").trim();
        if (rawPlatform) rawPlatforms.add(rawPlatform);
        const platform = normalizePlatform(rawPlatform, settings.platformAliases);
        if (!platform || item.sellPrice === null || item.sellPrice === undefined) continue;
        try {
          output.push({
            marketHashName,
            platform,
            rawPlatform,
            platformItemId: item.platformItemId ? String(item.platformItemId) : basePlatformId(marketHashName, platform, settings),
            sellPrice: normalizeSteamDTPrice(item.sellPrice),
            sellCount: Number(item.sellCount ?? 0),
            bidPrice: item.biddingPrice === null || item.biddingPrice === undefined ? null : normalizeSteamDTPrice(item.biddingPrice),
            bidCount: Number(item.biddingCount ?? 0),
            updatedAt: normalizeTimestamp(item.updateTime),
            fetchedAt: Date.now(),
            source: "live",
            status: Date.now() - normalizeTimestamp(item.updateTime) > 180_000 ? "stale" : "live",
          });
        } catch (error) {
          console.warn(`[SteamDT] 已忽略异常价格: ${marketHashName} / ${rawPlatform}: ${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
    }
    logPlatforms("价格响应", [...rawPlatforms]);
    return output;
  }
}

function basePlatformId(name: string, platform: "buff" | "youpin", settings: AppSettings): string | null {
  const base = getBaseItem(name);
  const match = base?.platformList.find((item) => normalizePlatform(item.name, settings.platformAliases) === platform);
  return match?.itemId ? String(match.itemId) : null;
}

function baseItemId(platformList: unknown[], platform: "buff" | "youpin"): string | null {
  const match = platformList.find((raw) => {
    const item = raw as { name?: unknown };
    return normalizePlatform(String(item.name ?? ""), defaultAliases) === platform;
  }) as { itemId?: unknown } | undefined;
  const value = String(match?.itemId ?? "").trim();
  return value || null;
}

function normalizeTimestamp(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return number < 10_000_000_000 ? number * 1000 : number;
}

function steamDTBodyError(message?: string, code?: number): ApiError {
  const text = message || "SteamDT 返回未知错误";
  if (/额度|quota|次数/i.test(text)) return new ApiError("SteamDT API 调用额度不足", 429);
  if (code === 401 || /授权|密钥|unauthor/i.test(text)) return new ApiError("SteamDT API 密钥无效或未授权", 401);
  if (/频繁|rate|limit|429/i.test(text)) return new ApiError("SteamDT 请求过于频繁，请稍后再试", 429);
  return new ApiError(`SteamDT 请求失败：${text}`);
}

function logPlatforms(source: string, names: string[]): void {
  const message = `[SteamDT] ${source}平台名称: ${names.join(", ") || "未返回"}`;
  console.info(message);
  try {
    const directory = path.join(process.cwd(), "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "steamdt-platforms.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch { /* 日志写入失败不影响扫描 */ }
}
