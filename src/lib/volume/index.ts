import { dailyVolumeCacheKey, getCachedDailyVolumes, getCsqaqItemMetadataBatch, saveDailyVolume } from "../db";
import { getCSQAQDailyVolume, getCSQAQItemMetadata } from "../csqaq";
import type { CsqaqItemMetadata } from "../types";
import { getShanghaiDayRange, unavailableVolume, type DailyVolumeResult, type VolumeLookupItem } from "./types";

export async function loadDailyVolumes(options: {
  items: VolumeLookupItem[];
  cacheSeconds: number;
  apiToken?: string;
  signal?: AbortSignal;
  cacheOnly?: boolean;
  metadataOnly?: boolean;
  sessionId?: string;
  onMetadata?: (metadata: CsqaqItemMetadata) => void;
  onResult?: (result: DailyVolumeResult) => void;
}): Promise<DailyVolumeResult[]> {
  const items = [...new Map(options.items.slice(0, 50).map((item) => [item.marketHashName, item])).values()];
  const stored = getCsqaqItemMetadataBatch(items.map((item) => item.marketHashName));
  for (const item of items) {
    const known = stored.get(item.marketHashName);
    const goodId = Number(item.csqaqGoodId ?? known?.csqaqGoodId);
    if (known) options.onMetadata?.(known);
    if (!options.cacheOnly && Number.isFinite(goodId) && (!known?.buffGoodsId || !known.youpinTemplateId)) {
      const metadata = await getCSQAQItemMetadata({ marketHashName: item.marketHashName, goodId, apiToken: options.apiToken, signal: options.signal, sessionId: options.sessionId });
      if (metadata) { stored.set(item.marketHashName, metadata); options.onMetadata?.(metadata); }
    }
  }
  if (options.metadataOnly) return [];

  const date = getShanghaiDayRange().date;
  const cached = getCachedDailyVolumes(items.map((item) => item.marketHashName), date, options.cacheSeconds * 1000);
  const results: DailyVolumeResult[] = [];
  for (const item of items) {
    const goodId = Number(item.csqaqGoodId ?? stored.get(item.marketHashName)?.csqaqGoodId);
    for (const platform of ["buff", "youpin"] as const) {
      const hit = cached.get(dailyVolumeCacheKey(item.marketHashName, platform));
      if (hit) { results.push(hit); options.onResult?.(hit); continue; }
      if (options.cacheOnly) continue;
      const result = !Number.isFinite(goodId) || goodId <= 0
        ? { ...unavailableVolume(item.marketHashName, platform, "csqaq-chart-unavailable-no-good-id"), status: "unavailable" as const }
        : await getCSQAQDailyVolume({ marketHashName: item.marketHashName, goodId, platform, apiToken: options.apiToken, signal: options.signal, sessionId: options.sessionId });
      saveDailyVolume(result);
      results.push(result);
      options.onResult?.(result);
    }
  }
  return results;
}

export type { DailyVolumeResult, VolumeLookupItem } from "./types";
export { getShanghaiDayRange } from "./types";
