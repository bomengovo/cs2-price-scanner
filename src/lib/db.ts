import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getBuffUrl, getYoupinUrl } from "./platform-links";
import { calculateComparison } from "./pricing";
import type { AppSettings, CsqaqItemMetadata, DomesticMarketData, PlatformPrice, ScanResult } from "./types";
import type { DailyVolumeResult, VolumePlatform } from "./volume/types";

let database: Database.Database | null = null;

function databasePath(): string {
  // The Windows launcher always supplies DB_PATH. Keep the fallback rooted at
  // Next's project working directory for ordinary npm usage as well.
  return path.resolve(/* turbopackIgnore: true */ process.env.DB_PATH || path.join(process.cwd(), "data", "scanner.db"));
}

export function getDb(): Database.Database {
  if (database) return database;
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  database = new Database(file);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS steamdt_base_items (
      market_hash_name TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform_list TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steamdt_prices (
      market_hash_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      raw_platform TEXT NOT NULL,
      platform_item_id TEXT,
      sell_price REAL NOT NULL,
      sell_count INTEGER NOT NULL DEFAULT 0,
      bid_price REAL,
      bid_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (market_hash_name, platform)
    );
    CREATE TABLE IF NOT EXISTS csfloat_listing_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      listings_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scanned_at INTEGER NOT NULL,
      scan_session_id TEXT,
      source TEXT NOT NULL DEFAULT 'live',
      result_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_volume_cache (
      market_hash_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      date TEXT NOT NULL,
      volume INTEGER,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (market_hash_name, platform, date)
    );
    CREATE TABLE IF NOT EXISTS api_rate_state (
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      last_request_at INTEGER NOT NULL DEFAULT 0,
      blocked_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, endpoint)
    );
    CREATE TABLE IF NOT EXISTS domestic_market_cache (
      market_hash_name TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      data_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS csqaq_item_metadata (
      market_hash_name TEXT PRIMARY KEY,
      csqaq_good_id INTEGER NOT NULL,
      buff_id TEXT,
      yyyp_id TEXT,
      item_type TEXT,
      turnover_number INTEGER,
      turnover_avg_price REAL,
      period_at TEXT,
      fetched_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turnover_enrichment_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      populated INTEGER NOT NULL DEFAULT 0,
      real_zero INTEGER NOT NULL DEFAULT 0,
      no_data INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      cache_hits INTEGER NOT NULL DEFAULT 0,
      rate_limited INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      message TEXT
    );
    CREATE TABLE IF NOT EXISTS scan_sessions (
      scan_session_id TEXT PRIMARY KEY,
      scanned_at INTEGER NOT NULL,
      fetched_listings INTEGER NOT NULL,
      unique_items INTEGER NOT NULL,
      matched_items INTEGER NOT NULL,
      qualified_items INTEGER NOT NULL,
      buff_comparable INTEGER NOT NULL,
      youpin_comparable INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_state (
      provider TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_success_at INTEGER,
      last_failure_at INTEGER,
      retry_at INTEGER,
      last_bind_at INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prices_updated_at ON steamdt_prices(updated_at);
    CREATE INDEX IF NOT EXISTS idx_csfloat_snapshots_fetched_at ON csfloat_listing_snapshots(fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_volume_cache_updated_at ON daily_volume_cache(updated_at);
    CREATE INDEX IF NOT EXISTS idx_domestic_market_cache_fetched_at ON domestic_market_cache(fetched_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_csqaq_metadata_good_id ON csqaq_item_metadata(csqaq_good_id);
    CREATE INDEX IF NOT EXISTS idx_csqaq_metadata_fetched_at ON csqaq_item_metadata(fetched_at);
  `);
  migratePersistentResults(database);
  const resultColumns = database.prepare("PRAGMA table_info(scan_results)").all() as Array<{ name: string }>;
  if (!resultColumns.some((column) => column.name === "previous_csfloat_cny")) database.exec("ALTER TABLE scan_results ADD COLUMN previous_csfloat_cny REAL");
  migrateCsqaqMetadata(database);
  const metadataColumns = database.prepare("PRAGMA table_info(csqaq_item_metadata)").all() as Array<{ name: string }>;
  if (!metadataColumns.some((column) => column.name === "turnover_number")) database.exec("ALTER TABLE csqaq_item_metadata ADD COLUMN turnover_number INTEGER");
  if (!metadataColumns.some((column) => column.name === "turnover_avg_price")) database.exec("ALTER TABLE csqaq_item_metadata ADD COLUMN turnover_avg_price REAL");
  if (!metadataColumns.some((column) => column.name === "period_at")) database.exec("ALTER TABLE csqaq_item_metadata ADD COLUMN period_at TEXT");
  const priorSchema = database.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get() as { value?: string } | undefined;
  if (Number(JSON.parse(priorSchema?.value ?? "0")) < 5) {
    // Pre-Stage-A records can have a fresh-looking metadata timestamp but no
    // turnover columns at all. Requeue only that legacy shape once.
    database.prepare("UPDATE csqaq_item_metadata SET fetched_at = NULL WHERE turnover_number IS NULL AND turnover_avg_price IS NULL AND period_at IS NULL").run();
  }
  const volumeColumns = database.prepare("PRAGMA table_info(daily_volume_cache)").all() as Array<{ name: string }>;
  if (!volumeColumns.some((column) => column.name === "good_id")) database.exec("ALTER TABLE daily_volume_cache ADD COLUMN good_id INTEGER");
  const sessionColumns = database.prepare("PRAGMA table_info(scan_sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "provider_json")) database.exec("ALTER TABLE scan_sessions ADD COLUMN provider_json TEXT");
  database.prepare("INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES ('schemaVersion', '6', ?)").run(Date.now());
  const baseColumns = database.prepare("PRAGMA table_info(steamdt_base_items)").all() as Array<{ name: string }>;
  if (!baseColumns.some((column) => column.name === "image_url")) {
    database.exec("ALTER TABLE steamdt_base_items ADD COLUMN image_url TEXT");
  }
  if (!baseColumns.some((column) => column.name === "buff_goods_id")) {
    database.exec("ALTER TABLE steamdt_base_items ADD COLUMN buff_goods_id TEXT");
  }
  if (!baseColumns.some((column) => column.name === "youpin_template_id")) {
    database.exec("ALTER TABLE steamdt_base_items ADD COLUMN youpin_template_id TEXT");
  }
  const priceColumns = database.prepare("PRAGMA table_info(steamdt_prices)").all() as Array<{ name: string }>;
  if (!priceColumns.some((column) => column.name === "provider_updated_at")) database.exec("ALTER TABLE steamdt_prices ADD COLUMN provider_updated_at INTEGER");
  if (!priceColumns.some((column) => column.name === "fetched_at")) database.exec("ALTER TABLE steamdt_prices ADD COLUMN fetched_at INTEGER");
  // One-time integrity migration: old result rows had no source/session and
  // can include legacy mock data. Old price caches are also not scan input.
  const migration = database.prepare("SELECT value FROM settings WHERE key = 'realtimeIntegrityMigrationV1'").get() as { value?: string } | undefined;
  if (!migration) {
    database.exec("DELETE FROM scan_results WHERE source = 'mock'");
    database.exec("DELETE FROM steamdt_prices;");
    database.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('realtimeIntegrityMigrationV1', 'true', ?)").run(Date.now());
  }
  database.exec("DROP TABLE IF EXISTS price_cache");
  database.pragma("optimize");
  return database;
}

export function closeDb(): void {
  database?.close();
  database = null;
}

export function getStoredSettings(): Partial<AppSettings> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)])) as Partial<AppSettings>;
}

export function saveSettings(input: Partial<AppSettings>): void {
  const db = getDb();
  const statement = db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `);
  const allowed = ["usdCnyRate", "priceCacheMinutes", "volumeCacheSeconds", "maxScanCount", "maxSafePages", "minDiff", "minDiffPercent", "platformAliases", "domesticProvider"];
  const now = Date.now();
  db.transaction(() => {
    for (const [key, value] of Object.entries(input)) {
      if (allowed.includes(key) && value !== undefined) statement.run(key, JSON.stringify(value), now);
    }
  })();
}

export function saveBaseItems(items: Array<{ name: string; marketHashName: string; platformList: unknown[]; imageUrl?: string | null; buffGoodsId?: string | null; youpinTemplateId?: string | null }>): void {
  const statement = getDb().prepare(`
    INSERT INTO steamdt_base_items(market_hash_name, name, platform_list, image_url, buff_goods_id, youpin_template_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_hash_name) DO UPDATE SET name=excluded.name, platform_list=excluded.platform_list,
    image_url=COALESCE(excluded.image_url, steamdt_base_items.image_url),
    buff_goods_id=COALESCE(excluded.buff_goods_id, steamdt_base_items.buff_goods_id),
    youpin_template_id=COALESCE(excluded.youpin_template_id, steamdt_base_items.youpin_template_id),
    updated_at=excluded.updated_at
  `);
  const now = Date.now();
  getDb().transaction(() => {
    for (const item of items) statement.run(item.marketHashName, item.name, JSON.stringify(item.platformList), item.imageUrl ?? null, item.buffGoodsId ?? null, item.youpinTemplateId ?? null, now);
  })();
}

export function baseItemsAreFresh(maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  const row = getDb().prepare("SELECT MAX(updated_at) AS updatedAt, COUNT(*) AS count FROM steamdt_base_items").get() as { updatedAt: number | null; count: number };
  return row.count > 0 && Boolean(row.updatedAt && row.updatedAt > Date.now() - maxAgeMs);
}

export function getBaseItem(marketHashName: string): { name: string; platformList: Array<{ name: string; itemId: string }>; imageUrl: string | null; buffGoodsId: string | null; youpinTemplateId: string | null } | null {
  const row = getDb().prepare("SELECT name, platform_list AS platformList, image_url AS imageUrl, buff_goods_id AS buffGoodsId, youpin_template_id AS youpinTemplateId FROM steamdt_base_items WHERE market_hash_name = ?").get(marketHashName) as { name: string; platformList: string; imageUrl: string | null; buffGoodsId: string | null; youpinTemplateId: string | null } | undefined;
  return row ? { name: row.name, platformList: JSON.parse(row.platformList), imageUrl: row.imageUrl, buffGoodsId: row.buffGoodsId, youpinTemplateId: row.youpinTemplateId } : null;
}

export function getCachedDailyVolumes(marketHashNames: string[], date: string, maxAgeMs: number): Map<string, DailyVolumeResult> {
  const output = new Map<string, DailyVolumeResult>();
  if (!marketHashNames.length) return output;
  const placeholders = marketHashNames.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT market_hash_name AS marketHashName, platform, good_id AS goodId, date, volume, source, updated_at AS fetchedAt
    FROM daily_volume_cache WHERE market_hash_name IN (${placeholders}) AND date = ? AND updated_at >= ?`)
    .all(...marketHashNames, date, Date.now() - maxAgeMs) as DailyVolumeResult[];
  for (const row of rows) output.set(`${row.marketHashName}:${row.platform}`, row);
  return output;
}

export function saveDailyVolume(result: DailyVolumeResult): void {
  getDb().prepare(`INSERT INTO daily_volume_cache(market_hash_name, platform, date, volume, source, updated_at, good_id)
    VALUES (@marketHashName, @platform, @date, @volume, @source, @fetchedAt, @goodId)
    ON CONFLICT(market_hash_name, platform, date) DO UPDATE SET
    volume=excluded.volume, source=excluded.source, updated_at=excluded.updated_at, good_id=excluded.good_id`).run({ ...result, goodId: result.goodId ?? null });
}

export function dailyVolumeCacheKey(marketHashName: string, platform: VolumePlatform): string {
  return `${marketHashName}:${platform}`;
}

export function getCachedPrices(names: string[], maxAgeMs: number): Map<string, PlatformPrice[]> {
  const output = new Map<string, PlatformPrice[]>();
  if (!names.length) return output;
  const placeholders = names.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT market_hash_name AS marketHashName, platform, raw_platform AS rawPlatform,
    platform_item_id AS platformItemId, sell_price AS sellPrice, sell_count AS sellCount,
    bid_price AS bidPrice, bid_count AS bidCount, COALESCE(provider_updated_at, updated_at) AS updatedAt,
    COALESCE(fetched_at, updated_at) AS fetchedAt
    FROM steamdt_prices WHERE market_hash_name IN (${placeholders})`).all(...names) as PlatformPrice[];
  for (const row of rows) {
    const age = Date.now() - (row.fetchedAt ?? 0);
    output.set(row.marketHashName, [...(output.get(row.marketHashName) ?? []), { ...row, source: "cache", status: age <= maxAgeMs ? "cache" : "stale" }]);
  }
  return output;
}

export function saveDomesticMarketData(items: import("./types").DomesticMarketData[]): void {
  const statement = getDb().prepare(`INSERT INTO domestic_market_cache(market_hash_name, source, data_json, fetched_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(market_hash_name) DO UPDATE SET source=excluded.source,
    data_json=excluded.data_json, fetched_at=excluded.fetched_at`);
  const metadata = getDb().prepare(`INSERT INTO csqaq_item_metadata(market_hash_name, csqaq_good_id, fetched_at, updated_at)
    VALUES (?, ?, NULL, ?) ON CONFLICT(market_hash_name) DO UPDATE SET csqaq_good_id=excluded.csqaq_good_id, updated_at=excluded.updated_at`);
  getDb().transaction(() => {
    for (const item of items) {
      statement.run(item.marketHashName, item.source, JSON.stringify(item), item.fetchedAt);
      if (item.goodId != null) metadata.run(item.marketHashName, item.goodId, item.fetchedAt);
    }
  })();
}

export function getCsqaqItemMetadata(marketHashName: string): CsqaqItemMetadata | null {
  const row = getDb().prepare(`SELECT market_hash_name AS marketHashName, csqaq_good_id AS csqaqGoodId,
    buff_id AS buffGoodsId, yyyp_id AS youpinTemplateId, item_type AS itemType,
    turnover_number AS turnoverNumber, turnover_avg_price AS turnoverAvgPrice, period_at AS periodAt,
    fetched_at AS fetchedAt, updated_at AS updatedAt FROM csqaq_item_metadata WHERE market_hash_name = ?`).get(marketHashName) as CsqaqItemMetadata | undefined;
  return row ?? null;
}

export function getCsqaqItemMetadataBatch(marketHashNames: string[]): Map<string, CsqaqItemMetadata> {
  const names = [...new Set(marketHashNames.filter(Boolean))];
  const output = new Map<string, CsqaqItemMetadata>();
  if (!names.length) return output;
  const placeholders = names.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT market_hash_name AS marketHashName, csqaq_good_id AS csqaqGoodId,
    buff_id AS buffGoodsId, yyyp_id AS youpinTemplateId, item_type AS itemType,
    turnover_number AS turnoverNumber, turnover_avg_price AS turnoverAvgPrice, period_at AS periodAt,
    fetched_at AS fetchedAt, updated_at AS updatedAt FROM csqaq_item_metadata WHERE market_hash_name IN (${placeholders})`).all(...names) as CsqaqItemMetadata[];
  for (const row of rows) output.set(row.marketHashName, row);
  return output;
}

export function saveCsqaqItemMetadata(item: CsqaqItemMetadata): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`INSERT INTO csqaq_item_metadata(market_hash_name, csqaq_good_id, buff_id, yyyp_id, item_type,
      turnover_number, turnover_avg_price, period_at, fetched_at, updated_at)
      VALUES (@marketHashName,@csqaqGoodId,@buffGoodsId,@youpinTemplateId,@itemType,@turnoverNumber,@turnoverAvgPrice,@periodAt,@fetchedAt,@updatedAt)
      ON CONFLICT(market_hash_name) DO UPDATE SET csqaq_good_id=excluded.csqaq_good_id,
      buff_id=COALESCE(excluded.buff_id,csqaq_item_metadata.buff_id), yyyp_id=COALESCE(excluded.yyyp_id,csqaq_item_metadata.yyyp_id),
      item_type=COALESCE(excluded.item_type,csqaq_item_metadata.item_type), turnover_number=excluded.turnover_number,
      turnover_avg_price=excluded.turnover_avg_price, period_at=excluded.period_at,
      fetched_at=excluded.fetched_at, updated_at=excluded.updated_at`).run(item);
    const existing = db.prepare("SELECT result_json AS resultJson FROM scan_results WHERE market_hash_name = ?").get(item.marketHashName) as { resultJson: string } | undefined;
    if (existing) {
      const result = JSON.parse(existing.resultJson) as ScanResult;
      const buffGoodsId = item.buffGoodsId ?? result.buffGoodsId;
      const youpinTemplateId = item.youpinTemplateId ?? result.youpinTemplateId;
      const patched: ScanResult = { ...result, csqaqGoodId: item.csqaqGoodId, buffGoodsId, youpinTemplateId,
        csqaqDailyVolume: item.turnoverNumber, csqaqVolumePeriodAt: item.periodAt,
        csqaqVolumeFetchedAt: item.fetchedAt, csqaqVolumeSource: "csqaq-info-good",
        // These legacy per-platform fields never had verified data. Keep them
        // null rather than representing the item-level CSQAQ figure twice.
        buffDailyVolume: null, uuDailyVolume: null, totalDailyVolume: null, volumeCoverage: "none",
        platformIds: { buff: buffGoodsId, youpin: youpinTemplateId },
        buffUrl: getBuffUrl(buffGoodsId, item.marketHashName), youpinUrl: getYoupinUrl(youpinTemplateId, item.marketHashName) };
      db.prepare("UPDATE scan_results SET result_json = ? WHERE market_hash_name = ?").run(JSON.stringify(patched), item.marketHashName);
    }
  })();
}

export type TurnoverEnrichmentState = {
  status: "idle" | "running" | "paused" | "rate_limited" | "auth_error" | "completed" | "failed";
  total: number;
  completed: number;
  populated: number;
  realZero: number;
  noData: number;
  failures: number;
  cacheHits: number;
  rateLimited: number;
  startedAt: number | null;
  updatedAt: number;
  message: string | null;
};

export function getTurnoverEnrichmentState(): TurnoverEnrichmentState {
  const row = getDb().prepare(`SELECT status, total, completed, populated, real_zero AS realZero, no_data AS noData,
    failures, cache_hits AS cacheHits, rate_limited AS rateLimited, started_at AS startedAt,
    updated_at AS updatedAt, message FROM turnover_enrichment_state WHERE id = 1`).get() as TurnoverEnrichmentState | undefined;
  return row ?? { status: "idle", total: 0, completed: 0, populated: 0, realZero: 0, noData: 0, failures: 0, cacheHits: 0, rateLimited: 0, startedAt: null, updatedAt: 0, message: null };
}

export function saveTurnoverEnrichmentState(state: Partial<TurnoverEnrichmentState> & Pick<TurnoverEnrichmentState, "status">): TurnoverEnrichmentState {
  const current = getTurnoverEnrichmentState();
  const next: TurnoverEnrichmentState = { ...current, ...state, updatedAt: Date.now() };
  getDb().prepare(`INSERT INTO turnover_enrichment_state(id, status, total, completed, populated, real_zero, no_data,
    failures, cache_hits, rate_limited, started_at, updated_at, message)
    VALUES (1,@status,@total,@completed,@populated,@realZero,@noData,@failures,@cacheHits,@rateLimited,@startedAt,@updatedAt,@message)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total, completed=excluded.completed,
    populated=excluded.populated, real_zero=excluded.real_zero, no_data=excluded.no_data, failures=excluded.failures,
    cache_hits=excluded.cache_hits, rate_limited=excluded.rate_limited, started_at=excluded.started_at,
    updated_at=excluded.updated_at, message=excluded.message`).run(next);
  return next;
}

export function getTurnoverCandidates(maxAgeMs: number): Array<{ marketHashName: string; csqaqGoodId: number; fetchedAt: number | null }> {
  const sourceClause = process.env.NODE_ENV === "test" ? "scan.is_deleted = 0" : "scan.is_deleted = 0 AND scan.source = 'live'";
  return getDb().prepare(`SELECT metadata.market_hash_name AS marketHashName, metadata.csqaq_good_id AS csqaqGoodId,
    metadata.fetched_at AS fetchedAt FROM csqaq_item_metadata metadata
    INNER JOIN scan_results scan ON scan.market_hash_name = metadata.market_hash_name
    WHERE ${sourceClause} AND metadata.csqaq_good_id > 0
      AND (metadata.fetched_at IS NULL OR metadata.fetched_at < ?)
    GROUP BY metadata.market_hash_name, metadata.csqaq_good_id, metadata.fetched_at
    ORDER BY metadata.fetched_at IS NOT NULL, scan.last_seen_at DESC`).all(Date.now() - maxAgeMs) as Array<{ marketHashName: string; csqaqGoodId: number; fetchedAt: number | null }>;
}

export function getTurnoverDatabaseStats(): { savedResults: number; goodIdAvailable: number; dailyVolumeAvailable: number; dailyVolumeZero: number; dailyVolumeUnknown: number } {
  const sourceClause = process.env.NODE_ENV === "test" ? "scan.is_deleted = 0" : "scan.is_deleted = 0 AND scan.source = 'live'";
  return getDb().prepare(`SELECT COUNT(*) AS savedResults,
    SUM(CASE WHEN metadata.csqaq_good_id > 0 THEN 1 ELSE 0 END) AS goodIdAvailable,
    SUM(CASE WHEN metadata.turnover_number IS NOT NULL THEN 1 ELSE 0 END) AS dailyVolumeAvailable,
    SUM(CASE WHEN metadata.turnover_number = 0 THEN 1 ELSE 0 END) AS dailyVolumeZero,
    SUM(CASE WHEN metadata.csqaq_good_id > 0 AND metadata.turnover_number IS NULL THEN 1 ELSE 0 END) AS dailyVolumeUnknown
    FROM scan_results scan LEFT JOIN csqaq_item_metadata metadata ON metadata.market_hash_name = scan.market_hash_name
    WHERE ${sourceClause}`).get() as { savedResults: number; goodIdAvailable: number; dailyVolumeAvailable: number; dailyVolumeZero: number; dailyVolumeUnknown: number };
}

export function getCachedDomesticMarketData(names: string[], maxAgeMs: number): Map<string, import("./types").DomesticMarketData> {
  const output = new Map<string, import("./types").DomesticMarketData>();
  if (!names.length) return output;
  const placeholders = names.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT data_json AS dataJson, fetched_at AS fetchedAt FROM domestic_market_cache
    WHERE market_hash_name IN (${placeholders}) AND fetched_at >= ?`).all(...names, Date.now() - maxAgeMs) as Array<{ dataJson: string; fetchedAt: number }>;
  for (const row of rows) {
    const data = JSON.parse(row.dataJson) as import("./types").DomesticMarketData;
    output.set(data.marketHashName, { ...data, source: "CSQAQ_CACHE", fetchedAt: row.fetchedAt });
  }
  return output;
}

export function savePrices(prices: PlatformPrice[]): void {
  const db = getDb();
  const main = db.prepare(`INSERT INTO steamdt_prices(market_hash_name, platform, raw_platform, platform_item_id, sell_price, sell_count, bid_price, bid_count, updated_at, provider_updated_at, fetched_at)
    VALUES (@marketHashName,@platform,@rawPlatform,@platformItemId,@sellPrice,@sellCount,@bidPrice,@bidCount,@updatedAt,@updatedAt,@fetchedAt)
    ON CONFLICT(market_hash_name,platform) DO UPDATE SET raw_platform=excluded.raw_platform, platform_item_id=excluded.platform_item_id,
    sell_price=excluded.sell_price, sell_count=excluded.sell_count, bid_price=excluded.bid_price, bid_count=excluded.bid_count, updated_at=excluded.updated_at, provider_updated_at=excluded.provider_updated_at, fetched_at=excluded.fetched_at`);
  db.transaction(() => prices.forEach((price) => main.run(price)))();
}

export function saveCsfloatSnapshot(snapshotId: string, listings: import("./types").CSFloatListing[]): number {
  const fetchedAt = Date.now();
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO csfloat_listing_snapshots(snapshot_id, fetched_at, listings_json) VALUES (?, ?, ?)").run(snapshotId, fetchedAt, JSON.stringify(listings));
  db.prepare("DELETE FROM csfloat_listing_snapshots WHERE snapshot_id NOT IN (SELECT snapshot_id FROM csfloat_listing_snapshots ORDER BY fetched_at DESC LIMIT 5)").run();
  return fetchedAt;
}

export function getLatestCsfloatSnapshot(): { snapshotId: string; fetchedAt: number; listings: import("./types").CSFloatListing[] } | null {
  const row = getDb().prepare("SELECT snapshot_id AS snapshotId, fetched_at AS fetchedAt, listings_json AS listingsJson FROM csfloat_listing_snapshots ORDER BY fetched_at DESC LIMIT 1").get() as { snapshotId: string; fetchedAt: number; listingsJson: string } | undefined;
  return row ? { snapshotId: row.snapshotId, fetchedAt: row.fetchedAt, listings: JSON.parse(row.listingsJson) } : null;
}

export function getRateState(provider: string, endpoint: string): { lastRequestAt: number; blockedUntil: number } {
  const row = getDb().prepare("SELECT last_request_at AS lastRequestAt, blocked_until AS blockedUntil FROM api_rate_state WHERE provider = ? AND endpoint = ?").get(provider, endpoint) as { lastRequestAt: number; blockedUntil: number } | undefined;
  return row ?? { lastRequestAt: 0, blockedUntil: 0 };
}

export function saveRateState(provider: string, endpoint: string, state: Partial<{ lastRequestAt: number; blockedUntil: number }>): void {
  const current = getRateState(provider, endpoint);
  getDb().prepare(`INSERT INTO api_rate_state(provider, endpoint, last_request_at, blocked_until) VALUES (?, ?, ?, ?)
    ON CONFLICT(provider, endpoint) DO UPDATE SET last_request_at=excluded.last_request_at, blocked_until=excluded.blocked_until`)
    .run(provider, endpoint, state.lastRequestAt ?? current.lastRequestAt, state.blockedUntil ?? current.blockedUntil);
}

export type ProviderState = {
  provider: string;
  status: string;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  retryAt: number | null;
  lastBindAt: number | null;
  consecutiveFailures: number;
  message: string | null;
  updatedAt: number;
};

export function getProviderState(provider: string): ProviderState {
  const row = getDb().prepare(`SELECT provider, status, last_success_at AS lastSuccessAt, last_failure_at AS lastFailureAt,
    retry_at AS retryAt, last_bind_at AS lastBindAt, consecutive_failures AS consecutiveFailures,
    message, updated_at AS updatedAt FROM provider_state WHERE provider = ?`).get(provider) as ProviderState | undefined;
  return row ?? { provider, status: "UNKNOWN", lastSuccessAt: null, lastFailureAt: null, retryAt: null, lastBindAt: null, consecutiveFailures: 0, message: null, updatedAt: 0 };
}

export function saveProviderState(provider: string, state: Partial<Omit<ProviderState, "provider" | "updatedAt">> & Pick<ProviderState, "status">): ProviderState {
  const current = getProviderState(provider);
  const next: ProviderState = { ...current, ...state, provider, updatedAt: Date.now() };
  getDb().prepare(`INSERT INTO provider_state(provider, status, last_success_at, last_failure_at, retry_at, last_bind_at,
    consecutive_failures, message, updated_at) VALUES (@provider,@status,@lastSuccessAt,@lastFailureAt,@retryAt,@lastBindAt,@consecutiveFailures,@message,@updatedAt)
    ON CONFLICT(provider) DO UPDATE SET status=excluded.status, last_success_at=excluded.last_success_at,
    last_failure_at=excluded.last_failure_at, retry_at=excluded.retry_at, last_bind_at=excluded.last_bind_at,
    consecutive_failures=excluded.consecutive_failures, message=excluded.message, updated_at=excluded.updated_at`).run(next);
  return next;
}

export function saveScanResults(results: ScanResult[], scanSessionId: string, source: "live" | "mock"): { scannedAt: number; stats: { added: number; updated: number; retained: number; deletedSkipped: number } } {
  const scannedAt = Date.now();
  const db = getDb();
  const find = db.prepare("SELECT result_json AS resultJson, is_deleted AS isDeleted FROM scan_results WHERE market_hash_name = ?");
  const insert = db.prepare(`INSERT INTO scan_results(market_hash_name, scan_session_id, source, result_json,
    first_seen_at, last_seen_at, last_price_update_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`);
  const replace = db.prepare(`UPDATE scan_results SET scan_session_id=?, source=?, result_json=?,
    last_seen_at=?, last_price_update_at=?, previous_csfloat_cny=? WHERE market_hash_name=?`);
  const touch = db.prepare("UPDATE scan_results SET last_seen_at=? WHERE market_hash_name=?");
  const stats = { added: 0, updated: 0, retained: 0, deletedSkipped: 0 };
  db.transaction(() => {
    for (const result of results) {
      const existing = find.get(result.marketHashName) as { resultJson: string; isDeleted: number } | undefined;
      if (!existing) {
        insert.run(result.marketHashName, scanSessionId, source, JSON.stringify(result), scannedAt, scannedAt, scannedAt);
        stats.added += 1;
        continue;
      }
      if (existing.isDeleted) {
        touch.run(scannedAt, result.marketHashName);
        stats.deletedSkipped += 1;
        continue;
      }
      const previous = JSON.parse(existing.resultJson) as ScanResult;
      const merged = mergeResultByFreshness(result, previous);
      if (hasResultChanged(merged, previous)) {
        replace.run(scanSessionId, source, JSON.stringify(merged), scannedAt, scannedAt, previous.csfloatCny, result.marketHashName);
        stats.updated += 1;
      } else {
        touch.run(scannedAt, result.marketHashName);
        stats.retained += 1;
      }
    }
  })();
  return { scannedAt, stats };
}

function isBetterListing(next: ScanResult, previous: ScanResult): boolean {
  if (next.csfloatCny !== previous.csfloatCny) return next.csfloatCny < previous.csfloatCny;
  const nextFloat = next.floatValue ?? Number.POSITIVE_INFINITY;
  const previousFloat = previous.floatValue ?? Number.POSITIVE_INFINITY;
  if (nextFloat !== previousFloat) return nextFloat < previousFloat;
  return new Date(next.createdAt).getTime() > new Date(previous.createdAt).getTime();
}

/** CSFloat listing selection and domestic market refresh are intentionally independent. */
function mergeResultByFreshness(next: ScanResult, previous: ScanResult): ScanResult {
  const listing = isBetterListing(next, previous) ? next : {
    ...next,
    id: previous.id, price: previous.price, createdAt: previous.createdAt, floatValue: previous.floatValue,
    defIndex: previous.defIndex, paintIndex: previous.paintIndex, paintSeed: previous.paintSeed,
    listingUrl: previous.listingUrl, inspectLink: previous.inspectLink, csfloatListingId: previous.csfloatListingId,
    csfloatUsd: previous.csfloatUsd, csfloatCny: previous.csfloatCny, csfloatFetchedAt: previous.csfloatFetchedAt,
    csfloatSource: previous.csfloatSource,
  };
  const merged = {
    ...listing,
    buff: chooseFreshPlatform(next.buff, previous.buff),
    youpin: chooseFreshPlatform(next.youpin, previous.youpin),
    dataUpdatedAt: Math.max(next.dataUpdatedAt ?? 0, previous.dataUpdatedAt ?? 0),
    scanSessionId: next.scanSessionId,
  } as ScanResult;
  // Price and listing freshness are independent. Recalculate every derived
  // comparison after choosing each platform's newest legitimate quote.
  return calculateComparison({
    ...merged,
    snapshotStatus: merged.csfloatSource === "cache" || merged.buff?.status === "stale" || merged.youpin?.status === "stale"
      ? "partial"
      : !merged.buff && !merged.youpin ? "unavailable" : "live",
  });
}

function chooseFreshPlatform(next: ScanResult["buff"], previous: ScanResult["buff"]): ScanResult["buff"] {
  if (!next) return previous;
  if (!previous) return next;
  return (next.fetchedAt ?? next.updatedAt ?? 0) >= (previous.fetchedAt ?? previous.updatedAt ?? 0) ? next : previous;
}

function hasResultChanged(next: ScanResult, previous: ScanResult): boolean {
  return JSON.stringify(next) !== JSON.stringify({ ...previous, scanSessionId: next.scanSessionId });
}

export function getLastScan(): { scannedAt: number; results: ScanResult[] } | null {
  const sourceClause = process.env.NODE_ENV === "test" ? "is_deleted = 0" : "is_deleted = 0 AND source = 'live'";
  const rows = getDb().prepare(`SELECT first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
    last_price_update_at AS lastPriceUpdateAt, previous_csfloat_cny AS previousCsfloatCny, result_json AS resultJson
    FROM scan_results WHERE ${sourceClause} ORDER BY last_seen_at DESC, id DESC`).all() as Array<{ firstSeenAt: number; lastSeenAt: number; lastPriceUpdateAt: number; previousCsfloatCny: number | null; resultJson: string }>;
  if (!rows.length) return null;
  const metadataByName = getCsqaqItemMetadataBatch(rows.flatMap((row) => {
    try { return [(JSON.parse(row.resultJson) as ScanResult).marketHashName]; } catch { return []; }
  }));
  const results = rows.map((row) => {
    const result = JSON.parse(row.resultJson) as ScanResult;
    const metadata = metadataByName.get(result.marketHashName);
    const buffGoodsId = metadata?.buffGoodsId ?? result.buffGoodsId ?? null;
    const youpinTemplateId = metadata?.youpinTemplateId ?? result.youpinTemplateId ?? null;
    return { ...result, csqaqGoodId: metadata?.csqaqGoodId ?? result.csqaqGoodId ?? null,
      buffGoodsId, youpinTemplateId, platformIds: { buff: buffGoodsId, youpin: youpinTemplateId },
      buffUrl: getBuffUrl(buffGoodsId, result.marketHashName), youpinUrl: getYoupinUrl(youpinTemplateId, result.marketHashName),
      csqaqDailyVolume: metadata?.turnoverNumber ?? result.csqaqDailyVolume ?? null,
      csqaqVolumePeriodAt: metadata?.periodAt ?? result.csqaqVolumePeriodAt ?? null,
      csqaqVolumeFetchedAt: metadata?.fetchedAt ?? result.csqaqVolumeFetchedAt ?? null,
      csqaqVolumeSource: metadata?.fetchedAt ? "csqaq-info-good" : result.csqaqVolumeSource ?? null,
      buffDailyVolume: null, uuDailyVolume: null, totalDailyVolume: null, volumeCoverage: "none" as const,
      firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, lastPriceUpdateAt: row.lastPriceUpdateAt,
      previousCsfloatCny: row.previousCsfloatCny, csfloatPriceChange: row.previousCsfloatCny == null ? null : result.csfloatCny - row.previousCsfloatCny };
  });
  return { scannedAt: Math.max(...rows.map((row) => row.lastSeenAt)), results };
}

export function softDeleteResults(marketHashNames: string[]): number {
  const names = [...new Set(marketHashNames.map((name) => name.trim()).filter(Boolean))];
  if (!names.length) return 0;
  const statement = getDb().prepare("UPDATE scan_results SET is_deleted = 1 WHERE market_hash_name = ? AND is_deleted = 0");
  let changed = 0;
  getDb().transaction(() => { for (const name of names) changed += statement.run(name).changes; })();
  return changed;
}

export function restoreDeletedResults(marketHashNames?: string[]): number {
  const names = marketHashNames?.map((name) => name.trim()).filter(Boolean);
  if (!names?.length) return getDb().prepare("UPDATE scan_results SET is_deleted = 0 WHERE is_deleted = 1").run().changes;
  const statement = getDb().prepare("UPDATE scan_results SET is_deleted = 0 WHERE market_hash_name = ? AND is_deleted = 1");
  let changed = 0;
  getDb().transaction(() => { for (const name of new Set(names)) changed += statement.run(name).changes; })();
  return changed;
}

export function permanentlyDeleteResults(marketHashNames?: string[]): number {
  const names = marketHashNames?.map((name) => name.trim()).filter(Boolean);
  if (!names?.length) return getDb().prepare("DELETE FROM scan_results WHERE is_deleted = 1").run().changes;
  const statement = getDb().prepare("DELETE FROM scan_results WHERE market_hash_name = ? AND is_deleted = 1");
  let changed = 0;
  getDb().transaction(() => { for (const name of new Set(names)) changed += statement.run(name).changes; })();
  return changed;
}

export function getDeletedResultCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS count FROM scan_results WHERE is_deleted = 1").get() as { count: number }).count;
}

export function updateSavedDomesticPrices(results: ScanResult[]): number {
  const statement = getDb().prepare(`UPDATE scan_results SET result_json = ?, last_price_update_at = ?
    WHERE market_hash_name = ? AND is_deleted = 0`);
  const now = Date.now();
  let changed = 0;
  getDb().transaction(() => {
    for (const result of results) changed += statement.run(JSON.stringify(result), now, result.marketHashName).changes;
  })();
  return changed;
}

export function saveScanSessionMetrics(scanSessionId: string, scannedAt: number, progress: import("./types").ScanProgress, provider?: unknown): void {
  getDb().prepare(`INSERT OR REPLACE INTO scan_sessions(scan_session_id, scanned_at, fetched_listings, unique_items,
    matched_items, qualified_items, buff_comparable, youpin_comparable, provider_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scanSessionId, scannedAt, progress.fetchedListings, progress.uniqueItems, progress.matchedItems, progress.qualifiedItems, progress.buffComparable, progress.youpinComparable, provider == null ? null : JSON.stringify(provider));
}

export function getLatestScanSessionMetrics(): (Omit<import("./types").ScanProgress, "phase" | "percent" | "status"> & { scannedAt: number; provider?: unknown }) | null {
  const row = getDb().prepare(`SELECT scanned_at AS scannedAt, fetched_listings AS fetchedListings, unique_items AS uniqueItems,
    matched_items AS matchedItems, qualified_items AS qualifiedItems, buff_comparable AS buffComparable,
    youpin_comparable AS youpinComparable, provider_json AS providerJson FROM scan_sessions ORDER BY scanned_at DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
  if (!row) return null;
  const providerJson = typeof row.providerJson === "string" ? row.providerJson : null;
  return { ...row, provider: providerJson ? JSON.parse(providerJson) : undefined } as ReturnType<typeof getLatestScanSessionMetrics>;
}

function migratePersistentResults(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(scan_results)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "market_hash_name")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_scan_results_last_seen ON scan_results(last_seen_at DESC)");
    return;
  }
  db.transaction(() => {
    db.exec("ALTER TABLE scan_results RENAME TO scan_result_batches");
    db.exec(`CREATE TABLE scan_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_hash_name TEXT NOT NULL UNIQUE,
      scan_session_id TEXT,
      source TEXT NOT NULL DEFAULT 'live',
      result_json TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_price_update_at INTEGER NOT NULL,
      previous_csfloat_cny REAL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1))
    )`);
    const batches = db.prepare(`SELECT scanned_at AS scannedAt, scan_session_id AS scanSessionId,
      source, result_json AS resultJson FROM scan_result_batches ORDER BY scanned_at ASC`).all() as Array<{
      scannedAt: number; scanSessionId: string | null; source: string; resultJson: string;
    }>;
    const insert = db.prepare(`INSERT INTO scan_results(
      market_hash_name, scan_session_id, source, result_json, first_seen_at, last_seen_at, last_price_update_at, is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(market_hash_name) DO UPDATE SET scan_session_id=excluded.scan_session_id,
      source=excluded.source, result_json=excluded.result_json,
      last_seen_at=excluded.last_seen_at, last_price_update_at=excluded.last_price_update_at`);
    for (const batch of batches) {
      let parsed: ScanResult[] = [];
      try { parsed = JSON.parse(batch.resultJson) as ScanResult[]; } catch { continue; }
      for (const result of parsed) {
        if (result?.marketHashName) insert.run(result.marketHashName, batch.scanSessionId, batch.source, JSON.stringify(result), batch.scannedAt, batch.scannedAt, batch.scannedAt);
      }
    }
    db.exec("CREATE INDEX idx_scan_results_last_seen ON scan_results(last_seen_at DESC)");
    db.prepare("INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES ('schemaVersion', '2', ?)").run(Date.now());
  })();
}

function migrateCsqaqMetadata(db: Database.Database): void {
  const upsert = db.prepare(`INSERT INTO csqaq_item_metadata(
      market_hash_name, csqaq_good_id, buff_id, yyyp_id, item_type, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_hash_name) DO UPDATE SET
      csqaq_good_id=excluded.csqaq_good_id,
      buff_id=COALESCE(excluded.buff_id, csqaq_item_metadata.buff_id),
      yyyp_id=COALESCE(excluded.yyyp_id, csqaq_item_metadata.yyyp_id),
      item_type=COALESCE(excluded.item_type, csqaq_item_metadata.item_type),
      fetched_at=COALESCE(excluded.fetched_at, csqaq_item_metadata.fetched_at),
      updated_at=MAX(excluded.updated_at, csqaq_item_metadata.updated_at)`);
  const rows = db.prepare(`SELECT market_hash_name AS marketHashName, data_json AS dataJson,
      fetched_at AS fetchedAt FROM domestic_market_cache`).all() as Array<{
        marketHashName: string; dataJson: string; fetchedAt: number;
      }>;
  const baseColumns = new Set((db.prepare("PRAGMA table_info(steamdt_base_items)").all() as Array<{ name: string }>).map((column) => column.name));
  const baseIds = baseColumns.has("buff_goods_id") && baseColumns.has("youpin_template_id")
    ? db.prepare("SELECT buff_goods_id AS buffGoodsId, youpin_template_id AS youpinTemplateId FROM steamdt_base_items WHERE market_hash_name = ?")
    : null;
  const now = Date.now();
  db.transaction(() => {
    for (const row of rows) {
      try {
        const data = JSON.parse(row.dataJson) as DomesticMarketData;
        if (data.goodId == null || !Number.isFinite(Number(data.goodId))) continue;
        const base = baseIds?.get(row.marketHashName) as { buffGoodsId: string | null; youpinTemplateId: string | null } | undefined;
        upsert.run(row.marketHashName, Number(data.goodId), base?.buffGoodsId ?? null,
          base?.youpinTemplateId ?? null, null, null, Math.max(row.fetchedAt, now));
      } catch { /* Ignore malformed legacy cache rows. */ }
    }
  })();
}

export function hasSuspiciousImageReuse(results: Array<Pick<ScanResult, "marketHashName" | "iconUrl">>): boolean {
  const appearancesByImage = new Map<string, Set<string>>();
  for (const result of results) {
    if (!result.iconUrl) continue;
    const appearance = result.marketHashName
      .replace(/^StatTrak™\s+|^Souvenir\s+/i, "")
      .replace(/ \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i, "");
    const appearances = appearancesByImage.get(result.iconUrl) ?? new Set<string>();
    appearances.add(appearance);
    appearancesByImage.set(result.iconUrl, appearances);
  }
  return [...appearancesByImage.values()].some((appearances) => appearances.size >= 5);
}
