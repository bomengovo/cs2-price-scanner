import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeCSFloatListing, fetchCSFloatListings, extractNextCursor } from "../src/lib/csfloat";
import { closeDb, getCachedDailyVolumes, getCsqaqItemMetadata, getDb, getLastScan, getLatestCsfloatSnapshot, getProviderState, getRateState, hasSuspiciousImageReuse, restoreDeletedResults, saveCsfloatSnapshot, saveDailyVolume, savePrices, saveProviderState, saveRateState, saveScanResults, softDeleteResults } from "../src/lib/db";
import { fetchWithRetry } from "../src/lib/http";
import { buildItemImageCandidates, categorizeItem, lowestListings, normalizeCsfloatImageUrl, resolveItemImage } from "../src/lib/items";
import { mockImageByMarketHashName, mockListings } from "../src/lib/mock";
import { normalizePlatform } from "../src/lib/platforms";
import { getBuffUrl, getCsfloatListingUrl, getCsfloatMarketUrl, getYoupinUrl, isValidBuffGoodsId, validatePlatformLinks } from "../src/lib/platform-links";
import { calculateComparison, centsToUsd, normalizeSteamDTPrice, usdToCny } from "../src/lib/pricing";
import { filterAndSortResults } from "../src/lib/result-utils";
import { runScan, selectBestListings } from "../src/lib/scanner";
import { ensureSteamDTBase, getSteamDTPrices } from "../src/lib/steamdt";
import { environmentSettings } from "../src/lib/config";
import type { ScanResult } from "../src/lib/types";
import { getShanghaiDayRange } from "../src/lib/volume";
import { parseRetryAfter, ProviderApiError } from "../src/lib/provider-error";
import { scheduleCsfloatListings } from "../src/lib/rate-limit/csfloat-scheduler";
import { csfloatNeedsProbe, csfloatStatus } from "../src/lib/rate-limit/csfloat-scheduler";
import { chunkMarketHashNames, domesticDataToPrices, getCSQAQDailyVolume, getCSQAQItemMetadata, getCSQAQMarketData, normalizeCSQAQItem } from "../src/lib/csqaq";
import { scheduleCsqaqBatch } from "../src/lib/rate-limit/csqaq-scheduler";
import { withCsqaqAuthRecovery } from "../src/lib/csqaq-ip-binding";
import { getCsfloatNetworkDiagnostics, pauseCsfloatForIpChange, refreshCsfloatNetworkDiagnostics, resetCsfloatNetworkDiagnosticsForTest } from "../src/lib/csfloat-network";

const dbPath = `D:/Codex/Temp/cs2-price-scanner-test-${process.pid}.db`;
let mockResults: ScanResult[] = [];

beforeAll(async () => {
  fs.mkdirSync("D:/Codex/Temp", { recursive: true });
  process.env.DB_PATH = dbPath;
  process.env.MOCK_MODE = "true";
  process.env.USD_CNY_RATE = "7.2";
  process.env.STEAMDT_BATCH_INTERVAL_MS = "0";
  process.env.CSFLOAT_MIN_INTERVAL_MS = "0";
  process.env.CSFLOAT_LISTINGS_AUTH_REQUIRED = "false";
  resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.10", checkedAt: Date.now() });
  process.env.CSQAQ_MIN_INTERVAL_MS = "0";
  closeDb();
  const output = await runScan({ limit: 30, forceRefresh: false }, () => undefined);
  mockResults = output.results;
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  vi.restoreAllMocks();
});

describe("SQLite 与 Mock 集成", () => {
  it("自动创建全部要求的表并持久化上次扫描", () => {
    const tables = getDb().prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    for (const required of ["steamdt_base_items", "steamdt_prices", "csfloat_listing_snapshots", "api_rate_state", "scan_results", "scan_sessions", "settings", "daily_volume_cache"]) expect(names).toContain(required);
    expect(names).not.toContain("price_cache");
    const baseColumns = getDb().prepare("PRAGMA table_info(steamdt_base_items)").all() as Array<{ name: string }>;
    expect(baseColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["buff_goods_id", "youpin_template_id"]));
    const resultColumns = getDb().prepare("PRAGMA table_info(scan_results)").all() as Array<{ name: string }>;
    expect(resultColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "market_hash_name", "first_seen_at", "last_seen_at", "last_price_update_at", "is_deleted",
    ]));
    const saved = getLastScan()?.results ?? [];
    expect(saved).toHaveLength(new Set(mockResults.map((item) => item.marketHashName)).size);
    expect(new Set(saved.map((item) => item.marketHashName)).size).toBe(saved.length);
    expect(saved.every((item) => item.firstSeenAt && item.lastSeenAt && item.lastPriceUpdateAt)).toBe(true);
    const savedNames = saved.map((item) => item.marketHashName);
    closeDb();
    expect(getLastScan()?.results.map((item) => item.marketHashName)).toEqual(savedNames);
    expect(JSON.parse((getDb().prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get() as { value: string }).value)).toBe(6);
  });

  it("Mock 扫描生成逐条 Listing、进度和可比价格", async () => {
    const phases: string[] = [];
    const output = await runScan({ limit: 25, forceRefresh: false }, (progress) => phases.push(progress.phase));
    expect(output.results.length).toBeGreaterThanOrEqual(new Set(mockResults.map((item) => item.marketHashName)).size);
    expect(output.results.every((item) => item.marketHashName && item.listingUrl)).toBe(true);
    expect(output.results.some((item) => item.buff && item.youpin)).toBe(true);
    expect(phases).toContain("done");
  });

  it("按完整 marketHashName 合并历史，并为重复 Listing 选择最低成本", () => {
    const base = mockListings(2)[0];
    const best = selectBestListings([
      { ...base, id: "higher", price: 2000, floatValue: 0.05, createdAt: "2026-01-01T00:00:00Z" },
      { ...base, id: "lower", price: 1500, floatValue: 0.20, createdAt: "2025-01-01T00:00:00Z" },
      { ...base, id: "same-price-better-float", price: 1500, floatValue: 0.10, createdAt: "2024-01-01T00:00:00Z" },
    ]);
    expect(best).toHaveLength(1);
    expect(best[0].id).toBe("same-price-better-float");
  });

  it("软删除后不显示、重复扫描不复活，并可恢复", async () => {
    const target = getLastScan()!.results[0].marketHashName;
    expect(softDeleteResults([target])).toBe(1);
    expect(getLastScan()!.results.some((item) => item.marketHashName === target)).toBe(false);
    await runScan({ limit: 30, forceRefresh: false }, () => undefined);
    expect(getLastScan()!.results.some((item) => item.marketHashName === target)).toBe(false);
    expect(restoreDeletedResults([target])).toBe(1);
    expect(getLastScan()!.results.some((item) => item.marketHashName === target)).toBe(true);
  });
});

describe("CSFloat 解析与 cursor 翻页", () => {
  it("严格解析 market_hash_name、磨损和 StatTrak 标志", () => {
    const parsed = normalizeCSFloatListing(rawListing(1, "StatTrak™ AK-47 | Redline (Field-Tested)"));
    expect(parsed?.marketHashName).toBe("StatTrak™ AK-47 | Redline (Field-Tested)");
    expect(parsed?.wearName).toBe("Field-Tested");
    expect(parsed?.isStatTrak).toBe(true);
    expect(parsed?.price).toBe(2001);
  });

  it("使用 50 条单页限制并携带下一页 cursor", async () => {
    const first = Array.from({ length: 50 }, (_, index) => rawListing(index + 1));
    const second = Array.from({ length: 10 }, (_, index) => rawListing(index + 51));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: first, cursor: "cursor-page-2" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: second, cursor: "unused" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const listings = await fetchCSFloatListings({ limit: 60, maxSafePages: 5, apiKey: "test-key" });
    expect(listings).toHaveLength(60);
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=50");
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=cursor-page-2");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("Authorization");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toHaveProperty("User-Agent");
    vi.unstubAllGlobals();
  });

  it("鉴权模式使用原始 API Key 格式且 100 条严格只请求两页", async () => {
    const original = process.env.CSFLOAT_LISTINGS_AUTH_REQUIRED;
    process.env.CSFLOAT_LISTINGS_AUTH_REQUIRED = "true";
    const first = Array.from({ length: 50 }, (_, index) => rawListing(index + 1));
    const second = Array.from({ length: 50 }, (_, index) => rawListing(index + 51));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: first, cursor: "real-opaque-cursor" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: second, cursor: "next-unused" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const listings = await fetchCSFloatListings({ limit: 100, maxSafePages: 5, apiKey: "test-api-key" });
    expect(listings).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "test-api-key" });
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=real-opaque-cursor");
    process.env.CSFLOAT_LISTINGS_AUTH_REQUIRED = original;
    vi.unstubAllGlobals();
  });

  it("处理完整 URL、Steam 相对 ID、空值和单行加载失败", () => {
    expect(normalizeCsfloatImageUrl("abc123")).toBe("https://community.cloudflare.steamstatic.com/economy/image/abc123/360fx360f");
    expect(normalizeCsfloatImageUrl("https://example.com/item.png")).toBe("https://example.com/item.png");
    expect(normalizeCsfloatImageUrl("http://example.com/item.png")).toBe("https://example.com/item.png");
    expect(normalizeCsfloatImageUrl("//community.cloudflare.steamstatic.com/economy/image/abc")).toBe("https://community.cloudflare.steamstatic.com/economy/image/abc");
    expect(buildItemImageCandidates("abc123")).toEqual([
      "https://community.cloudflare.steamstatic.com/economy/image/abc123/360fx360f",
      "https://community.akamai.steamstatic.com/economy/image/abc123/360fx360f",
    ]);
    expect(normalizeCsfloatImageUrl(null)).toBe("");
    expect(resolveItemImage("https://example.com/item.png", true)).toBeNull();
    expect(resolveItemImage("https://example.com/item.png", false)).toBe("https://example.com/item.png");
  });

  it("不同 marketHashName 使用各自的真实饰品图片", () => {
    const required = [
      "AK-47 | Redline (Field-Tested)",
      "M4A1-S | Printstream (Minimal Wear)",
      "AWP | Asiimov (Field-Tested)",
      "USP-S | Kill Confirmed (Battle-Scarred)",
      "Glock-18 | Water Elemental (Factory New)",
    ];
    const listings = mockListings(12);
    const images = required.map((marketHashName) => {
      const listing = listings.find((item) => item.marketHashName === marketHashName);
      expect(listing?.iconUrl).toBe(mockImageByMarketHashName.get(marketHashName));
      return listing?.iconUrl;
    });
    expect(new Set(images).size).toBe(required.length);
  });

  it("识别并清理多个不同皮肤共用同一图片的旧扫描缓存", () => {
    const bad = Array.from({ length: 5 }, (_, index) => ({ marketHashName: `Weapon ${index} | Skin ${index} (Field-Tested)`, iconUrl: "https://example.com/same.png" }));
    expect(hasSuspiciousImageReuse(bad)).toBe(true);
    expect(hasSuspiciousImageReuse(mockListings(12))).toBe(false);
  });
});

describe("SteamDT 授权、解析、Alias 与限流错误", () => {
  it("基础信息请求携带 Bearer 密钥并写入 SQLite", async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: [{ name: "AK-47｜红线", marketHashName: "AK-47 | Redline (Field-Tested)", platformList: [{ name: "BUFF163", itemId: "101" }, { name: "YOUPIN", itemId: "202" }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await ensureSteamDTBase("secret-test-key");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-test-key");
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM steamdt_base_items").get()).toMatchObject({ count: 1 });
    expect(getDb().prepare("SELECT buff_goods_id AS buff, youpin_template_id AS youpin FROM steamdt_base_items").get()).toMatchObject({ buff: "101", youpin: "202" });
    vi.unstubAllGlobals();
  });

  it("解析 BUFF/UU 价格并校验价格单位", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: [{ marketHashName: "Test Item", dataList: [{ platform: "BUFF163", platformItemId: "88", sellPrice: 123.45, sellCount: 9, biddingPrice: 110, biddingCount: 2, updateTime: 1700000000 }, { platform: "YOUPIN", platformItemId: "99", sellPrice: 126.5, sellCount: 7, biddingPrice: 111, biddingCount: 1, updateTime: 1700000000 }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await getSteamDTPrices({ marketHashNames: ["Test Item"], apiKey: "key", settings: environmentSettings(), forceRefresh: true });
    expect(response.prices.get("Test Item")?.map((item) => item.platform)).toEqual(["buff", "youpin"]);
    expect(response.prices.get("Test Item")?.[0].sellPrice).toBe(123.45);
    expect(() => normalizeSteamDTPrice(20_000_000)).toThrow("数量级异常");
    vi.unstubAllGlobals();
  });

  it("正确归一化平台别名并把 429 转成中文错误", async () => {
    const aliases = environmentSettings().platformAliases;
    expect(normalizePlatform("BUFF163", aliases)).toBe("buff");
    expect(normalizePlatform("悠悠有品", aliases)).toBe("youpin");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));
    await expect(fetchWithRetry("https://example.com", {}, { retries: 0 })).rejects.toEqual(expect.objectContaining({ status: 429, message: "API 请求过于频繁，请稍后重试" }));
    vi.unstubAllGlobals();
  });
});

describe("CSQAQ 主国内数据源", () => {
  it("401 后只绑定一次并重试原请求一次，成功后标记恢复", async () => {
    vi.stubEnv("CSQAQ_API_TOKEN", "test-csqaq-token");
    saveProviderState("csqaq", { status: "CSQAQ_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await withCsqaqAuthRecovery(() => fetchWithRetry("https://example.test/csqaq", {}, { retries: 0 }));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getProviderState("csqaq").status).toBe("CSQAQ_AUTH_RECOVERED");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("401 恢复失败会打开熔断，后续请求不再打网络", async () => {
    vi.stubEnv("CSQAQ_API_TOKEN", "test-csqaq-token");
    saveProviderState("csqaq", { status: "CSQAQ_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(withCsqaqAuthRecovery(() => fetchWithRetry("https://example.test/csqaq", {}, { retries: 0 }))).rejects.toMatchObject({ status: 401 });
    await expect(withCsqaqAuthRecovery(() => fetchWithRetry("https://example.test/csqaq", {}, { retries: 0 }))).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getProviderState("csqaq").status).toBe("CSQAQ_AUTH_ERROR");
    saveProviderState("csqaq", { status: "CSQAQ_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it.each([[49, [49]], [50, [50]], [51, [50, 1]], [100, [50, 50]], [101, [50, 50, 1]]])("%i 个名称按 50 上限拆批", (count, expected) => {
    expect(chunkMarketHashNames(Array.from({ length: count }, (_, index) => `Item ${index}`)).map((batch) => batch.length)).toEqual(expected);
  });

  it("全局 Scheduler 对相同 Batch 使用 Single Flight", async () => {
    saveRateState("csqaq", "batch", { lastRequestAt: 0, blockedUntil: 0 });
    let calls = 0;
    const run = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return new Response("{}"); };
    const [first, second] = await Promise.all([
      scheduleCsqaqBatch({ key: "same-batch", run }),
      scheduleCsqaqBatch({ key: "same-batch", run }),
    ]);
    expect(calls).toBe(1);
    expect(await first.text()).toBe("{}");
    expect(await second.text()).toBe("{}");
  });
  it("解析官方 Batch Schema 与求购/在售字段", () => {
    const item = normalizeCSQAQItem("fallback", { goodId: 6733, marketHashName: "★ Bowie Knife", buffSellPrice: 1340, buffSellNum: 43, buffBuyPrice: 1300, yyypSellPrice: 1309, yyypSellNum: 35, yyypBuyPrice: 1288 });
    expect(item.marketHashName).toBe("★ Bowie Knife");
    expect(item.buff).toMatchObject({ sellPrice: 1340, buyPrice: 1300, sellCount: 43 });
    expect(item.yyyp).toMatchObject({ sellPrice: 1309, buyPrice: 1288, sellCount: 35 });
    expect(domesticDataToPrices(new Map([[item.marketHashName, item]])).get(item.marketHashName)?.map((price) => price.platform)).toEqual(["buff", "youpin"]);
  });

  it("51 个名称严格拆成 50+1 两个 Batch 并使用 ApiToken", async () => {
    const names = Array.from({ length: 51 }, (_, index) => `CSQAQ Test ${process.pid}-${index}`);
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const requested = (JSON.parse(String(init.body)) as { marketHashNameList: string[] }).marketHashNameList;
      return new Response(JSON.stringify({ code: 200, msg: "Success", data: { success: Object.fromEntries(requested.map((name) => [name, { marketHashName: name, buffSellPrice: 10, buffSellNum: 2, yyypSellPrice: 11, yyypSellNum: 3 }])) } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const output = await getCSQAQMarketData({ marketHashNames: names, apiToken: "token-test", cacheMinutes: 1, forceRefresh: true });
    expect(output.batchRequests).toBe(2);
    expect(output.matched).toBe(51);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ ApiToken: "token-test" });
    expect((JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { marketHashNameList: string[] }).marketHashNameList).toHaveLength(50);
    vi.unstubAllGlobals();
  });

  it("日成交量接口请求 Chart 并解析当日成交量", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200, data: {
      timestamp: [1735603200, 1735689600, 1735776000],
      num_data: [88, 120, 145],
      main_data: [100, 100, 100],
    } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getCSQAQDailyVolume({ marketHashName: "Galil AR | Rocket Pop (Minimal Wear)", goodId: 1041, platform: "buff", apiToken: "token-test" });
    expect(result).toMatchObject({ volume: 145, status: "live", goodId: 1041 });
    expect(result.source).toMatch(/^csqaq-chart:/);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.csqaq.com/api/v1/info/chart");
    expect((init.headers as Record<string, string>).ApiToken).toBe("token-test");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ good_id: "1041", key: "turnover_number", platform: 1, period: "30", style: "all_style" });
    vi.unstubAllGlobals();
  });

  it("日成交量 Chart 返回空数据时保持未知且不抛错", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { timestamp: [], num_data: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getCSQAQDailyVolume({ marketHashName: "Galil AR | Rocket Pop (Minimal Wear)", goodId: 1041, platform: "youpin", apiToken: "token-test" });
    expect(result).toMatchObject({ volume: null, status: "unavailable", goodId: 1041 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("一次 /info/good 同时持久化平台 ID、日成交量、均价和统计日期", async () => {
    const name = `Turnover metadata ${process.pid}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { goods_info: {
      market_hash_name: name, buff_id: "100", yyyp_id: "200", turnover_number: 116, turnover_avg_price: 12.34, period_at: "2025-11-03T00:00:00",
    } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const metadata = await getCSQAQItemMetadata({ marketHashName: name, goodId: 901001, forceRefresh: true });
    expect(metadata).toMatchObject({ buffGoodsId: "100", youpinTemplateId: "200", turnoverNumber: 116, turnoverAvgPrice: 12.34, periodAt: "2025-11-03T00:00:00" });
    expect(getCsqaqItemMetadata(name)).toMatchObject({ turnoverNumber: 116, turnoverAvgPrice: 12.34, periodAt: "2025-11-03T00:00:00" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("日成交量保留真实 0，null 和缺失字段均保持未知", async () => {
    const cases = [{ suffix: "zero", value: 0, expected: 0 }, { suffix: "null", value: null, expected: null }, { suffix: "missing", value: undefined, expected: null }];
    for (const [index, sample] of cases.entries()) {
      const name = `Turnover ${sample.suffix} ${process.pid}`;
      const info: Record<string, unknown> = { market_hash_name: name, buff_id: "1", yyyp_id: "2" };
      if (sample.value !== undefined) info.turnover_number = sample.value;
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { goods_info: info } }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const metadata = await getCSQAQItemMetadata({ marketHashName: name, goodId: 901010 + index, forceRefresh: true });
      expect(metadata?.turnoverNumber).toBe(sample.expected);
      vi.unstubAllGlobals();
    }
  });

  it("新鲜 CSQAQ metadata 命中缓存，同 goodId 并发只发一个请求", async () => {
    const name = `Turnover single flight ${process.pid}`;
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ code: 200, data: { goods_info: { market_hash_name: name, buff_id: "1", yyyp_id: "2", turnover_number: 7 } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const [first, second] = await Promise.all([
      getCSQAQItemMetadata({ marketHashName: name, goodId: 901100, forceRefresh: true }),
      getCSQAQItemMetadata({ marketHashName: name, goodId: 901100, forceRefresh: true }),
    ]);
    expect(first?.turnoverNumber).toBe(7);
    expect(second?.turnoverNumber).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getCSQAQItemMetadata({ marketHashName: name, goodId: 901100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("价格、筛选、搜索、排序和链接", () => {
  it("统一换算 CNY 并正确计算两平台价差", () => {
    expect(centsToUsd(12345)).toBe(123.45);
    expect(usdToCny(10, 7.2)).toBe(72);
    const base = mockResults[0];
    const result = calculateComparison({ ...base, csfloatCny: 100, buff: base.buff ? { ...base.buff, sellPrice: 125 } : null, youpin: base.youpin ? { ...base.youpin, sellPrice: 110 } : null });
    expect(result.buffDiff).toBe(25);
    expect(result.bestDiffPercent).toBe(25);
    expect(result.bestPlatform).toBe("buff");
  });

  it("最低价去重严格使用完整 marketHashName", () => {
    const deduped = lowestListings(mockResults);
    expect(deduped).toHaveLength(12);
    expect(deduped.find((item) => item.marketHashName.includes("Redline"))?.id).toBe("mock-1");
  });

  it("价格范围、百分比、中文搜索、品类与排序真实生效", () => {
    const filtered = filterAndSortResults(mockResults, { listingMode: "lowest", comparisonMode: "any", search: "红线", category: "guns", priceSource: "csfloat", minPrice: 100, maxPrice: 300, minDiff: 0, minPercent: 5, sortBy: "diffPercentDesc" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].marketHashName).toContain("Redline");
    const sorted = filterAndSortResults(mockResults, { listingMode: "lowest", comparisonMode: "any", search: "", category: "all", priceSource: "csfloat", minDiff: 0, minPercent: 0, sortBy: "csAsc" });
    expect(sorted[0].csfloatCny).toBeLessThanOrEqual(sorted.at(-1)!.csfloatCny);
    const volumeCandidates = [
      { ...mockResults[0], csqaqDailyVolume: 116 },
      { ...mockResults[1], csqaqDailyVolume: 23 },
      { ...mockResults[2], csqaqDailyVolume: null },
    ];
    const volumeFiltered = filterAndSortResults(volumeCandidates, { listingMode: "all", comparisonMode: "any", search: "", category: "all", priceSource: "csfloat", minDiff: 0, minPercent: 0, minDailyVolume: 100, sortBy: "csqaqVolumeDesc" });
    expect(volumeFiltered.map((item) => item.csqaqDailyVolume)).toEqual([116]);
    const volumeSorted = filterAndSortResults(volumeCandidates, { listingMode: "all", comparisonMode: "any", search: "", category: "all", priceSource: "csfloat", minDiff: 0, minPercent: 0, sortBy: "csqaqVolumeAsc" });
    expect(volumeSorted.map((item) => item.csqaqDailyVolume)).toEqual([23, 116, null]);
    const negativeMatch = { ...mockResults[1], buffDiff: -1, youpinDiff: -2, bestDiff: -1, bestDiffPercent: -1 };
    const allMatched = filterAndSortResults([mockResults[0], negativeMatch], { listingMode: "lowest", comparisonMode: "all", search: "", category: "all", priceSource: "csfloat", minDiff: Number.NEGATIVE_INFINITY, minPercent: Number.NEGATIVE_INFINITY, sortBy: "recent" });
    expect(allMatched).toHaveLength(2);
    expect(allMatched.some((item) => (item.bestDiff ?? 0) <= 0)).toBe(true);
  });

  it("按三类独立 ID 生成固定平台链接，缺失或错误 ID 时禁用", () => {
    expect(getCsfloatListingUrl("744760206885522064")).toBe("https://csfloat.com/item/744760206885522064");
    expect(getBuffUrl("44871")).toBe("https://buff.163.com/goods/44871");
    const youpin = new URL(getYoupinUrl("121658")!);
    expect(youpin.origin + youpin.pathname).toBe("https://youpin898.com/market/goods-list");
    expect(Object.fromEntries(youpin.searchParams)).toMatchObject({ gameId: "730", listType: "10", templateId: "121658" });
    for (const invalid of [undefined, null, "", "undefined", "null", "NaN", "AK-47 | Redline (Field-Tested)", "abc-123"]) {
      expect(getBuffUrl(invalid)).toBeNull();
      expect(getYoupinUrl(invalid)).toBeNull();
    }
    expect(isValidBuffGoodsId("44871", "AK-47 | Redline (Field-Tested)")).toBe(true);
  });

  it("使用 encodeURIComponent 编码 CSFloat marketHashName 特殊字符", () => {
    const names = ["AK-47 | 红线 (久经沙场)", "★ Karambit | Doppler (Factory New)", "StatTrak™ AK-47 | Slate (Minimal Wear)"];
    for (const name of names) expect(getCsfloatMarketUrl(name)).toBe(`https://csfloat.com/search?market_hash_name=${encodeURIComponent(name)}`);
    expect(getCsfloatMarketUrl(" ")).toBeNull();
  });

  it("开发链接验证器检查至少 10 个不同饰品且平台 ID 不串用", () => {
    const checks = validatePlatformLinks(mockResults, 10);
    expect(checks).toHaveLength(10);
    expect(checks.every((check) => check.valid)).toBe(true);
    expect(mockResults.find((item) => item.marketHashName.includes("Redline"))).toMatchObject({ buffGoodsId: "33960", youpinTemplateId: "1414" });
  });

  it("成交量按 Asia/Shanghai 分日并缓存 null，不使用 sellCount", () => {
    const range = getShanghaiDayRange(new Date("2026-08-07T16:30:00.000Z"));
    expect(range.date).toBe("2026-08-08");
    expect(range.start.toISOString()).toBe("2026-08-07T16:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-08-08T16:00:00.000Z");
    const cached = { marketHashName: "AK-47 | Redline (Field-Tested)", platform: "buff" as const, volume: null, date: range.date, source: "login-required", fetchedAt: Date.now() };
    saveDailyVolume(cached);
    expect(getCachedDailyVolumes([cached.marketHashName], range.date, 300_000).get(`${cached.marketHashName}:buff`)).toMatchObject({ volume: null, source: "login-required" });
    expect(mockResults[0].buff?.sellCount).not.toBe(mockResults[0].buffDailyVolume);
  });

  it("识别枪械、刀和手套品类", () => {
    expect(categorizeItem("AWP | Asiimov (Field-Tested)")).toBe("sniper");
    expect(categorizeItem("★ Karambit | Doppler (Factory New)")).toBe("knife");
    expect(categorizeItem("★ Sport Gloves | Vice (Field-Tested)")).toBe("gloves");
  });
});

describe("provider scheduling and cache integrity", () => {
  it("保留较优 CSFloat Listing 时仍更新国内价格并重新计算利润", () => {
    const name = `Domestic merge ${process.pid}`;
    const base = calculateComparison({ ...mockResults[0], marketHashName: name, id: `merge-old-${process.pid}`, csfloatCny: 100, csfloatUsd: 14, price: 1400,
      buff: { ...mockResults[0].buff!, marketHashName: name, sellPrice: 120, fetchedAt: 1000, updatedAt: 1000 },
      youpin: null, scanSessionId: "merge-old" });
    const incoming = calculateComparison({ ...base, id: `merge-new-${process.pid}`, price: 1600, csfloatCny: 115, csfloatUsd: 16, createdAt: "2026-01-01T00:00:00Z",
      buff: { ...base.buff!, sellPrice: 155, fetchedAt: 2000, updatedAt: 2000 }, scanSessionId: "merge-new" });
    saveScanResults([base], "merge-old", "mock");
    saveScanResults([incoming], "merge-new", "mock");
    const saved = getLastScan()!.results.find((item) => item.marketHashName === name)!;
    expect(saved.csfloatCny).toBe(100);
    expect(saved.buff?.sellPrice).toBe(155);
    expect(saved.bestDiff).toBe(55);
  });
  it("accepts only trusted cursor fields and never falls back to a listing id", () => {
    const arrayResponse = new Response(JSON.stringify([{ id: "listing-123" }]), { status: 200 });
    expect(extractNextCursor(arrayResponse, [{ id: "listing-123" }])).toBeNull();
    expect(extractNextCursor(new Response("", { headers: { "x-next-cursor": "header-cursor" } }), {})).toBe("header-cursor");
    expect(extractNextCursor(new Response(""), { next_cursor: "body-cursor" })).toBe("body-cursor");
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-08-12T00:00:00Z");
    expect(parseRetryAfter("2", now)).toBe(2_000);
    expect(parseRetryAfter("Wed, 12 Aug 2026 00:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("invalid", now)).toBeNull();
  });

  it("persists a CSFloat 429 cooldown and makes no second network request", async () => {
    saveRateState("csfloat", "listings", { lastRequestAt: 0, blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.10", checkedAt: Date.now() });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "2" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "rate-test", page: 1, caller: "test" }))
      .rejects.toEqual(expect.objectContaining<Partial<ProviderApiError>>({ httpStatus: 429, errorCode: "CSFLOAT_RATE_LIMIT" }));
    expect(getRateState("csfloat", "listings").blockedUntil).toBeGreaterThan(Date.now());
    await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "rate-test", page: 1, caller: "test" }))
      .rejects.toEqual(expect.objectContaining<Partial<ProviderApiError>>({ errorCode: "LOCAL_COOLDOWN" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    saveRateState("csfloat", "listings", { blockedUntil: 0 });
    vi.unstubAllGlobals();
  });

  it("classifies the multi-IP 429 into a long global cooldown without retrying", async () => {
    saveRateState("csfloat", "listings", { lastRequestAt: 0, blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.10", checkedAt: Date.now() });
    const fetchMock = vi.fn().mockResolvedValue(new Response("You've been making too many requests from too many IPs", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "multi-ip-test", page: 1, caller: "test" }))
      .rejects.toEqual(expect.objectContaining<Partial<ProviderApiError>>({ errorCode: "CSFLOAT_MULTI_IP_BLOCKED" }));
    expect(getProviderState("csfloat").status).toBe("CSFLOAT_MULTI_IP_BLOCKED");
    expect(getRateState("csfloat", "listings").blockedUntil).toBeGreaterThanOrEqual(Date.now() + 1_700_000);
    await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "multi-ip-test", page: 1, caller: "test" }))
      .rejects.toEqual(expect.objectContaining<Partial<ProviderApiError>>({ errorCode: "LOCAL_COOLDOWN" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    saveRateState("csfloat", "listings", { blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    vi.unstubAllGlobals();
  });

  it("pauses CSFloat before networking when the observed public IP changes", async () => {
    saveRateState("csfloat", "listings", { lastRequestAt: 0, blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.11", checkedAt: Date.now(), ipChanged: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "ip-change-test", page: 1, caller: "test" }))
      .rejects.toEqual(expect.objectContaining<Partial<ProviderApiError>>({ errorCode: "CSFLOAT_IP_CHANGED" }));
    expect(getProviderState("csfloat").status).toBe("CSFLOAT_IP_CHANGED");
    expect(fetchMock).not.toHaveBeenCalled();
    saveRateState("csfloat", "listings", { blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    vi.unstubAllGlobals();
  });

  it("reports CSFLOAT_PROBE after a cooldown expires but before recovery is verified", () => {
    saveRateState("csfloat", "listings", { lastRequestAt: 0, blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_MULTI_IP_BLOCKED", consecutiveFailures: 1, retryAt: null, message: null });
    resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.10", checkedAt: Date.now() });
    const status = csfloatStatus();
    expect(status.status).toBe("CSFLOAT_PROBE");
    expect(status.blocked).toBe(false);
    expect(csfloatNeedsProbe()).toBe(true);
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
  });

  it("sends exactly one minimal probe before resuming pagination after a multi-IP cooldown", async () => {
    saveRateState("csfloat", "listings", { lastRequestAt: 0, blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_MULTI_IP_BLOCKED", consecutiveFailures: 1, retryAt: null, message: null });
    resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.10", checkedAt: Date.now() });
    const urls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("limit=1")) return new Response(JSON.stringify({ data: [rawListing(1)] }), { status: 200 });
      return new Response(JSON.stringify({ data: Array.from({ length: 50 }, (_, index) => rawListing(index + 1)) }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const listings = await fetchCSFloatListings({ limit: 50, maxSafePages: 2, apiKey: "probe-key", sessionId: "probe-session" });
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls[0]).toContain("limit=1");
    expect(getProviderState("csfloat").status).toBe("CSFLOAT_LIVE");
    expect(listings.length).toBeGreaterThan(0);
    saveRateState("csfloat", "listings", { blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    vi.unstubAllGlobals();
  });

  it("background IP refresh persists a pause when the public IP changes", async () => {
    saveRateState("csfloat", "listings", { lastRequestAt: 0, blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.10", checkedAt: Date.now() - 70_000 });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ip: "203.0.113.77" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const diagnostics = await refreshCsfloatNetworkDiagnostics(false);
    expect(diagnostics.ipChanged).toBe(true);
    expect(diagnostics.currentPublicIp).toBe("203.0.113.77");
    expect(getProviderState("csfloat").status).toBe("CSFLOAT_IP_CHANGED");
    expect(getRateState("csfloat", "listings").blockedUntil).toBeGreaterThan(Date.now());
    saveRateState("csfloat", "listings", { blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    vi.unstubAllGlobals();
  });

  it("pauseCsfloatForIpChange persists the IP_CHANGED cooldown", () => {
    saveRateState("csfloat", "listings", { lastRequestAt: 0, blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
    resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.10", checkedAt: Date.now() });
    pauseCsfloatForIpChange("203.0.113.10", "203.0.113.55");
    expect(getProviderState("csfloat").status).toBe("CSFLOAT_IP_CHANGED");
    expect(getRateState("csfloat", "listings").blockedUntil).toBeGreaterThanOrEqual(Date.now() + 1_700_000);
    expect(getCsfloatNetworkDiagnostics().ipChanged).toBe(false); // diagnostics unchanged; state persisted only
    saveRateState("csfloat", "listings", { blockedUntil: 0 });
    saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
  });

  it("stores and restores a CSFloat listing snapshot", () => {
    const listing = normalizeCSFloatListing(rawListing(900));
    expect(listing).not.toBeNull();
    saveCsfloatSnapshot("snapshot-test", [listing!]);
    expect(getLatestCsfloatSnapshot()).toMatchObject({ snapshotId: "snapshot-test", listings: [{ id: "900" }] });
  });

  it("uses fresh SteamDT cache without a network request", async () => {
    const name = "Cache Test Item";
    savePrices([{ marketHashName: name, platform: "buff", rawPlatform: "BUFF163", platformItemId: "42", sellPrice: 88, sellCount: 1, bidPrice: null, bidCount: 0, updatedAt: Date.now(), fetchedAt: Date.now(), source: "live", status: "live" }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await getSteamDTPrices({ marketHashNames: [name], apiKey: "unused", settings: environmentSettings(), forceRefresh: false });
    expect(response.fetched).toBe(0);
    expect(response.prices.get(name)?.[0]).toMatchObject({ sellPrice: 88, source: "cache", status: "cache" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

function rawListing(id: number, name = `AK-47 | Redline (Field-Tested)`): Record<string, unknown> {
  return { id: String(id), price: 2000 + id, created_at: "2026-08-07T00:00:00Z", type: "buy_now", item: { market_hash_name: name, item_name: name.replace(/ \([^)]*\)$/, ""), wear_name: "Field-Tested", float_value: 0.22, def_index: 7, paint_index: 282, paint_seed: id, is_stattrak: name.startsWith("StatTrak™"), is_souvenir: name.startsWith("Souvenir"), icon_url: "abc", inspect_link: "steam://inspect" } };
}
