import { lowestListings } from "./items";
import type { ItemCategory, ScanResult } from "./types";

const gunCategories: ItemCategory[] = ["rifle", "sniper", "pistol", "smg", "shotgun", "machinegun"];

export interface ResultQuery {
  listingMode: "lowest" | "all";
  comparisonMode: "all" | "any" | "both" | "buff" | "youpin";
  search: string;
  category: string;
  priceSource: "csfloat" | "buff" | "youpin";
  minPrice?: number;
  maxPrice?: number;
  minDiff: number;
  minPercent: number;
  minDailyVolume?: number;
  sortBy: string;
}

export function filterAndSortResults(results: ScanResult[], query: ResultQuery): ScanResult[] {
  const source = query.listingMode === "lowest" ? lowestListings(results) : [...results];
  const search = query.search.trim().toLocaleLowerCase();
  const priceOf = (item: ScanResult) => query.priceSource === "buff" ? item.buff?.sellPrice : query.priceSource === "youpin" ? item.youpin?.sellPrice : item.csfloatCny;
  // Daily volume prefers the CSQAQ chart (当日) value; falls back to metadata turnover.
  const dailyVolumeOf = (item: ScanResult) => item.totalDailyVolume ?? item.csqaqDailyVolume;
  const matchesMode = (item: ScanResult) => {
    if (query.comparisonMode === "all") return Boolean(item.buff || item.youpin);
    const buffLow = (item.buffDiff ?? -Infinity) > 0;
    const uuLow = (item.youpinDiff ?? -Infinity) > 0;
    return query.comparisonMode === "both" ? buffLow && uuLow : query.comparisonMode === "buff" ? buffLow : query.comparisonMode === "youpin" ? uuLow : buffLow || uuLow;
  };
  const output = source.filter((item) => {
    const price = priceOf(item);
    if (!matchesMode(item)) return false;
    if (search && !`${item.itemName} ${item.chineseName} ${item.marketHashName}`.toLocaleLowerCase().includes(search)) return false;
    if (query.category === "guns" && !gunCategories.includes(item.category)) return false;
    if (query.category !== "all" && query.category !== "guns" && item.category !== query.category) return false;
    if (query.minPrice !== undefined && (price == null || price < query.minPrice)) return false;
    if (query.maxPrice !== undefined && (price == null || price > query.maxPrice)) return false;
    if ((query.minDailyVolume ?? 0) > 0) {
      const volume = dailyVolumeOf(item);
      if (volume == null || volume < query.minDailyVolume!) return false;
    }
    return (item.bestDiff ?? -Infinity) >= query.minDiff && (item.bestDiffPercent ?? -Infinity) >= query.minPercent;
  });
  const asc = (value: number | null | undefined) => value ?? Infinity;
  const desc = (value: number | null | undefined) => value ?? -Infinity;
  return output.sort((a, b) => {
    switch (query.sortBy) {
      case "csAsc": return a.csfloatCny - b.csfloatCny;
      case "csDesc": return b.csfloatCny - a.csfloatCny;
      case "buffAsc": return asc(a.buff?.sellPrice) - asc(b.buff?.sellPrice);
      case "buffDesc": return desc(b.buff?.sellPrice) - desc(a.buff?.sellPrice);
      case "uuAsc": return asc(a.youpin?.sellPrice) - asc(b.youpin?.sellPrice);
      case "uuDesc": return desc(b.youpin?.sellPrice) - desc(a.youpin?.sellPrice);
      case "diffDesc": return desc(b.bestDiff) - desc(a.bestDiff);
      case "csqaqVolumeDesc": return desc(dailyVolumeOf(b)) - desc(dailyVolumeOf(a));
      case "csqaqVolumeAsc": return asc(dailyVolumeOf(a)) - asc(dailyVolumeOf(b));
      case "floatAsc": return asc(a.floatValue) - asc(b.floatValue);
      case "firstSeenDesc": return desc(b.firstSeenAt) - desc(a.firstSeenAt);
      case "updatedDesc": return desc(b.lastPriceUpdateAt ?? b.dataUpdatedAt) - desc(a.lastPriceUpdateAt ?? a.dataUpdatedAt);
      case "recent": return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      default: return desc(b.bestDiffPercent) - desc(a.bestDiffPercent);
    }
  });
}
