export type CanonicalPlatform = "buff" | "youpin";

export interface CSFloatListing {
  id: string;
  price: number;
  createdAt: string;
  marketHashName: string;
  itemName: string;
  wearName: string;
  floatValue: number | null;
  defIndex: number | null;
  paintIndex: number | null;
  paintSeed: number | null;
  isStatTrak: boolean;
  isSouvenir: boolean;
  iconUrl: string;
  imageUrls?: string[];
  inspectLink: string;
  listingUrl: string;
}

export interface PlatformPrice {
  marketHashName: string;
  platform: CanonicalPlatform;
  rawPlatform: string;
  platformItemId: string | null;
  sellPrice: number;
  sellCount: number;
  bidPrice: number | null;
  bidCount: number;
  updatedAt: number;
  fetchedAt?: number;
  source?: "live" | "cache" | "mock" | "csqaq-live" | "csqaq-cache" | "steamdt-fallback";
  status?: "live" | "cache" | "stale";
}

export type DomesticProviderMode = "csqaq" | "auto" | "steamdt";
export type DomesticDataSource = "CSQAQ_LIVE" | "CSQAQ_CACHE" | "STEAMDT_FALLBACK";

export interface DomesticMarketData {
  marketHashName: string;
  goodId?: number;
  buff: { sellPrice?: number; buyPrice?: number; sellCount?: number; buyCount?: number };
  yyyp: { sellPrice?: number; buyPrice?: number; sellCount?: number; buyCount?: number };
  source: DomesticDataSource;
  fetchedAt: number;
}

export interface CsqaqItemMetadata {
  marketHashName: string;
  csqaqGoodId: number;
  buffGoodsId: string | null;
  youpinTemplateId: string | null;
  itemType: string | null;
  turnoverNumber: number | null;
  turnoverAvgPrice: number | null;
  periodAt: string | null;
  fetchedAt: number | null;
  updatedAt: number;
}

export interface ScanResult extends CSFloatListing {
  chineseName: string;
  category: ItemCategory;
  csfloatUsd: number;
  csfloatCny: number;
  buff: PlatformPrice | null;
  youpin: PlatformPrice | null;
  buffDiff: number | null;
  buffDiffPercent: number | null;
  youpinDiff: number | null;
  youpinDiffPercent: number | null;
  bestSellPrice: number | null;
  bestPlatform: CanonicalPlatform | null;
  bestDiff: number | null;
  bestDiffPercent: number | null;
  isDoubleLow: boolean;
  csfloatListingId: string | null;
  csqaqGoodId: number | null;
  buffGoodsId: string | null;
  youpinTemplateId: string | null;
  platformIds: {
    buff: string | null;
    youpin: string | null;
  };
  /** Item-level CSQAQ indicator, not a BUFF/悠悠 platform-specific volume. */
  csqaqDailyVolume: number | null;
  csqaqVolumePeriodAt: string | null;
  csqaqVolumeFetchedAt: number | null;
  csqaqVolumeSource: string | null;
  csfloatDailyVolume: number | null;
  buffDailyVolume: number | null;
  uuDailyVolume: number | null;
  totalDailyVolume: number | null;
  volumeCoverage: "none" | "partial" | "complete";
  buffUrl: string | null;
  youpinUrl: string | null;
  dataUpdatedAt: number;
  scanSessionId: string;
  snapshotStatus: "live" | "partial" | "unavailable";
  csfloatFetchedAt: number;
  csfloatSource: "live" | "cache" | "mock";
  firstSeenAt?: number;
  lastSeenAt?: number;
  lastPriceUpdateAt?: number;
  previousCsfloatCny?: number | null;
  csfloatPriceChange?: number | null;
}

export type ItemCategory =
  | "rifle"
  | "sniper"
  | "pistol"
  | "smg"
  | "shotgun"
  | "machinegun"
  | "knife"
  | "gloves"
  | "other";

export interface ScanProgress {
  phase: "idle" | "csfloat" | "domestic" | "steamdt" | "compare" | "done" | "error" | "stopped";
  percent: number;
  fetchedListings: number;
  uniqueItems: number;
  matchedItems: number;
  qualifiedItems: number;
  buffComparable: number;
  youpinComparable: number;
  status: string;
}

/** Persisted truth for the most recent scan; never inferred from result history. */
export interface ScanSessionState {
  scanStartedAt: number;
  scanFinishedAt: number;
  csfloatProvider: "LIVE" | "SNAPSHOT" | "RATE_LIMITED" | "ERROR" | "MOCK";
  domesticProvider: "CSQAQ" | "STEAMDT_FALLBACK" | "STEAMDT" | "CACHE" | "ERROR" | "MOCK";
  csfloatFetchedAt: number | null;
  domesticFetchedAt: number | null;
  savedAt: number;
}

export interface AppSettings {
  usdCnyRate: number;
  priceCacheMinutes: number;
  volumeCacheSeconds: number;
  maxScanCount: number;
  maxSafePages: number;
  minDiff: number;
  minDiffPercent: number;
  platformAliases: Record<CanonicalPlatform, string[]>;
  steamdtApiConfigured: boolean;
  csfloatApiConfigured: boolean;
  csqaqApiConfigured: boolean;
  domesticProvider: DomesticProviderMode;
  mockMode: boolean;
}

export interface ScanRequest {
  limit: number | "all";
  forceRefresh: boolean;
}
