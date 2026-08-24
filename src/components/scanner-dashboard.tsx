"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Database,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Zap,
} from "lucide-react";
import { buildItemImageCandidates } from "@/lib/items";
import { filterAndSortResults } from "@/lib/result-utils";
import type { AppSettings, ScanProgress, ScanResult, ScanSessionState } from "@/lib/types";

const initialProgress: ScanProgress = {
  phase: "idle",
  percent: 0,
  fetchedListings: 0,
  uniqueItems: 0,
  matchedItems: 0,
  qualifiedItems: 0,
  buffComparable: 0,
  youpinComparable: 0,
  status: "等待开始扫描",
};
const categories = [
  ["all", "全部"],
  ["guns", "仅枪械"],
  ["rifle", "步枪"],
  ["sniper", "狙击枪"],
  ["pistol", "手枪"],
  ["smg", "冲锋枪"],
  ["shotgun", "霰弹枪"],
  ["machinegun", "机枪"],
  ["knife", "刀"],
  ["gloves", "手套"],
  ["other", "其他"],
];
type ResultView = "all" | "profit" | "filtered";
type MergeStats = {
  added: number;
  updated: number;
  retained: number;
  deletedSkipped: number;
};
type ProviderStatus = "csqaq" | "steamdt-fallback" | "steamdt" | "unknown" | "CSQAQ_LIVE" | "CSQAQ_CACHE" | "CSQAQ_AUTH_RECOVERED" | "CSQAQ_AUTH_ERROR" | "CSQAQ_RATE_LIMITED" | "CSQAQ_UNAVAILABLE" | "STEAMDT_FALLBACK" | "STEAMDT" | "CSQAQ" | "CACHE" | "ERROR" | "MOCK";
type CsfloatRuntime = { status?: string; remainingMs?: number; diagnostics?: { currentPublicIp?: string | null; proxyEnabled?: boolean; lastErrorType?: string | null; lastErrorAt?: number | null } };
type TurnoverTask = {
  status: "idle" | "running" | "paused" | "rate_limited" | "auth_error" | "completed" | "failed";
  total: number;
  completed: number;
  populated: number;
  realZero: number;
  noData: number;
  failures: number;
  cacheHits: number;
  rateLimited: number;
  message: string | null;
  database?: { savedResults: number; goodIdAvailable: number; dailyVolumeAvailable: number; dailyVolumeZero: number; dailyVolumeUnknown: number };
};
type StreamEvent = {
  type: string;
  progress?: ScanProgress;
  results?: ScanResult[];
  scannedAt?: number;
  settings?: AppSettings;
  warnings?: string[];
  merge?: MergeStats;
  domestic?: { provider?: ProviderStatus };
  session?: ScanSessionState;
  error?: string;
  result?: unknown;
  metadata?: unknown;
};

export default function ScannerDashboard() {
  const [results, setResults] = useState<ScanResult[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [progress, setProgress] = useState(initialProgress);
  const [scanning, setScanning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [merge, setMerge] = useState<MergeStats>({
    added: 0,
    updated: 0,
    retained: 0,
    deletedSkipped: 0,
  });
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [scanLimit, setScanLimit] = useState("100");
  const [resultView, setResultView] = useState<ResultView>("all");
  const [comparisonMode, setComparisonMode] = useState("any");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [priceSource, setPriceSource] = useState("csfloat");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minDiff, setMinDiff] = useState("0");
  const [minPercent, setMinPercent] = useState("0");
  const [minDailyVolume, setMinDailyVolume] = useState("");
  const [sortBy, setSortBy] = useState("diffPercentDesc");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deletedCount, setDeletedCount] = useState(0);
  const [pendingTurnovers, setPendingTurnovers] = useState<Set<string>>(new Set());
  const [turnoverTask, setTurnoverTask] = useState<TurnoverTask | null>(null);
  const [csfloatBlockedUntil, setCsfloatBlockedUntil] = useState(0);
  const [csfloatRuntime, setCsfloatRuntime] = useState<CsfloatRuntime>({});
  const [clock, setClock] = useState(() => Date.now());
  const [domesticProvider, setDomesticProvider] =
    useState<ProviderStatus>("unknown");
  const [sessionProvider, setSessionProvider] = useState<Partial<ScanSessionState>>({});
  const abortRef = useRef<AbortController | null>(null);
  const loadedPageKeys = useRef(new Set<string>());

  const refreshRateState = useCallback(async () => {
    try {
      const response = await fetch("/api/rate-status", { cache: "no-store" });
      const data = await response.json();
      setCsfloatBlockedUntil(Number(data.csfloat?.blockedUntil ?? 0));
      setCsfloatRuntime(data.csfloat ?? {});
    } catch {
      // The dashboard remains usable from SQLite when diagnostics are unavailable.
    }
  }, []);

  const reloadResults = useCallback(async () => {
    try {
      const data = await fetch("/api/results", { cache: "no-store" }).then(
        (response) => response.json(),
      );
      setSettings(data.settings);
      setResults(data.results ?? []);
      const session = normalizeSession(data.lastMetrics?.provider);
      setDomesticProvider(domesticProviderFromSession(session) ?? "unknown");
      setSessionProvider(session);
      setLastScanAt(data.lastScanAt ?? null);
      if (data.settings) {
        setMinDiff(String(data.settings.minDiff ?? 0));
        setMinPercent(String(data.settings.minDiffPercent ?? 0));
      }
      if (data.results?.length) {
        const metrics = data.lastMetrics;
        setProgress((current) =>
          current.phase === "idle"
            ? {
                ...initialProgress,
                ...(metrics ?? {}),
                phase: "done",
                percent: 100,
                status: metrics
                  ? "已恢复上次扫描统计与持久化结果"
                  : "已从数据库恢复持久化结果",
              }
            : current,
        );
      }
    } catch {
      setError("无法读取本地持久化结果");
    }
  }, []);

  async function startScan() {
    if (scanning || refreshing) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setScanning(true);
    setError("");
    setWarnings([]);
    setProgress({
      ...initialProgress,
      phase: "csfloat",
      percent: 1,
      status: "正在启动扫描",
    });
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: scanLimit === "all" ? "all" : Number(scanLimit),
          forceRefresh: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(
          (await response.json().catch(() => null))?.error ??
            "扫描服务启动失败",
        );
      await readNdjson(response.body, (event) => {
        if (event.type === "progress" && event.progress)
          setProgress(event.progress);
        if (event.type === "result") {
          const scanResults = event.results ?? [];
          setResults(scanResults);
          setLastScanAt(event.scannedAt ?? Date.now());
          if (event.settings) setSettings(event.settings);
          setWarnings(event.warnings ?? []);
          setMerge(
            event.merge ?? {
              added: 0,
              updated: 0,
              retained: 0,
              deletedSkipped: 0,
            },
          );
          setDomesticProvider(
            domesticProviderFromSession(event.session) ?? event.domestic?.provider ?? "unknown",
          );
          setSessionProvider(event.session ?? {});
          void refreshRateState();
          setResultView("all");
        }
        if (event.type === "error") throw new Error(event.error ?? "扫描失败");
      });
    } catch (scanError) {
      if (controller.signal.aborted)
        setProgress((current) => ({
          ...current,
          phase: "stopped",
          status: "扫描已停止",
        }));
      else {
        setError(scanError instanceof Error ? scanError.message : "扫描失败");
        setProgress((current) => ({
          ...current,
          phase: "error",
          status: "扫描失败",
        }));
      }
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  }

  async function refreshSavedPrices() {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    setWarnings([]);
    try {
      const response = await fetch("/api/results/refresh-prices", {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "刷新已保存商品价格失败");
      setResults(data.results ?? []);
      setWarnings(data.warnings ?? []);
      setMerge((current) => ({
        ...current,
        updated: Number(data.updated ?? 0),
      }));
      setDomesticProvider(
        data.provider ?? "unknown",
      );
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "刷新已保存商品价格失败",
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function deleteItems(names: string[]) {
    if (!names.length) return;
    const response =
      names.length === 1
        ? await fetch(`/api/results/${encodeURIComponent(names[0])}`, {
            method: "DELETE",
          })
        : await fetch("/api/results/delete-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ marketHashNames: names }),
          });
    if (!response.ok) {
      setError("删除商品失败");
      return;
    }
    setResults((current) =>
      current.filter((item) => !names.includes(item.marketHashName)),
    );
    setSelected(new Set());
    setDeletedCount((count) => count + names.length);
  }

  async function restoreAll() {
    const response = await fetch("/api/results/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      setError("恢复商品失败");
      return;
    }
    setDeletedCount(0);
    await reloadResults();
  }

  async function startTurnoverEnrichment(items: ScanResult[] = []) {
    const unique = [...new Map(items.slice(0, 50).map((item) => [item.marketHashName, item])).values()];
    setPendingTurnovers((current) => new Set([
      ...current,
      ...unique
        .filter((item) => item.csqaqGoodId != null && item.csqaqGoodId > 0 && item.csqaqVolumeFetchedAt == null)
        .map((item) => item.marketHashName),
    ]));
    try {
      const response = await fetch("/api/turnover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: unique.map((item) => ({ marketHashName: item.marketHashName, csqaqGoodId: item.csqaqGoodId })) }),
      });
      if (!response.ok) throw new Error("日成交量补全任务启动失败");
      setTurnoverTask(await response.json());
    } catch {
      /* Auxiliary enrichment must never affect scanner or page availability. */
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void reloadResults(), 0);
    return () => window.clearTimeout(timer);
  }, [reloadResults]);
  useEffect(() => {
    void fetch("/api/results/restore", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setDeletedCount(Number(d.deletedCount ?? 0)))
      .catch(() => undefined);
    const rateTimer = window.setTimeout(() => { void refreshRateState(); }, 0);
    const ratePoll = window.setInterval(() => { void refreshRateState(); }, 5_000);
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { window.clearTimeout(rateTimer); window.clearInterval(ratePoll); window.clearInterval(timer); };
  }, [refreshRateState]);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch("/api/turnover", { cache: "no-store" });
        if (!response.ok || !active) return;
        const task = await response.json() as TurnoverTask;
        if (!active) return;
        setTurnoverTask(task);
        if (task.status === "running" || task.status === "rate_limited") await reloadResults();
      } catch { /* Background state is optional UI information. */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [reloadResults]);

  const queryBase = useMemo(
    () => ({
      listingMode: "lowest" as const,
      search,
      category: "all",
      priceSource: "csfloat" as const,
      minDiff: Number.NEGATIVE_INFINITY,
      minPercent: Number.NEGATIVE_INFINITY,
      sortBy,
    }),
    [search, sortBy],
  );
  const matchedAll = useMemo(
    () =>
      filterAndSortResults(results, {
        ...queryBase,
        search: "",
        comparisonMode: "all",
      }),
    [results, queryBase],
  );
  const matchedView = useMemo(
    () =>
      filterAndSortResults(results, { ...queryBase, comparisonMode: "all" }),
    [results, queryBase],
  );
  const profitAll = useMemo(
    () =>
      filterAndSortResults(results, {
        ...queryBase,
        search: "",
        comparisonMode: "any",
        minDiff: 0,
        minPercent: 0,
      }),
    [results, queryBase],
  );
  const profitView = useMemo(
    () =>
      filterAndSortResults(results, {
        ...queryBase,
        comparisonMode: "any",
        minDiff: 0,
        minPercent: 0,
      }),
    [results, queryBase],
  );
  const filteredResults = useMemo(
    () =>
      filterAndSortResults(results, {
        listingMode: "lowest",
        comparisonMode: comparisonMode as "any" | "both" | "buff" | "youpin",
        search,
        category,
        priceSource: priceSource as "csfloat" | "buff" | "youpin",
        minPrice: numberOrUndefined(minPrice),
        maxPrice: numberOrUndefined(maxPrice),
        minDiff: Number(minDiff || 0),
        minPercent: Number(minPercent || 0),
        minDailyVolume: numberOrUndefined(minDailyVolume),
        sortBy,
      }),
    [
      results,
      comparisonMode,
      search,
      category,
      priceSource,
      minPrice,
      maxPrice,
      minDiff,
      minPercent,
      minDailyVolume,
      sortBy,
    ],
  );
  const visibleResults =
    resultView === "all"
      ? matchedView
      : resultView === "profit"
        ? profitView
        : filteredResults;
  const totalPages = Math.max(1, Math.ceil(visibleResults.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageResults = visibleResults.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const pageIdentity = pageResults
    .slice(0, 50)
    .map((item) => `${item.marketHashName}:${item.csqaqGoodId ?? ""}`)
    .join("|");
  const maxDiff = Math.max(
    0,
    ...visibleResults.map((item) => item.bestDiff ?? 0),
  );
  const cooldown = Math.max(0, Math.ceil((csfloatBlockedUntil - clock) / 1000));

  useEffect(() => {
    const current = pageResults.slice(0, 50);
    if (!current.length) return;
    if (loadedPageKeys.current.has(pageIdentity)) return;
    loadedPageKeys.current.add(pageIdentity);
    void startTurnoverEnrichment(current);
    // Current-page identity is intentionally represented by the filter/page dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIdentity]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">C2</div>
          <div>
            <h1>CS2 跨平台价差扫描器</h1>
            <p>CSFLOAT · BUFF · 悠悠有品</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span
            className={`status-pill ${settings?.mockMode ? "mock" : "live"}`}
          >
            <span />
            {settings?.mockMode ? "Mock 模式" : "真实数据"}
          </span>
          <span className="rate-pill">
            USD/CNY <b>{settings?.usdCnyRate?.toFixed(4) ?? "--"}</b>
          </span>
          <Link href="/settings" className="icon-button">
            <Settings size={17} />
            设置
          </Link>
        </div>
      </header>

      <section className="hero-panel">
        <div>
          <p className="eyebrow">
            <ShieldCheck size={15} />
            严格按完整 Steam marketHashName 匹配
          </p>
          <h2>
            持久积累跨市场机会，
            <br />
            更快锁定低价挂单。
          </h2>
          <p className="hero-copy">
            CSFloat 负责发现真实在售 Listing，CSQAQ
            批量提供国内价格；所有匹配结果持续保存在本地工作台。
          </p>
        </div>
        <div className="scan-controls">
          <div className="scope-control">
            <label>扫描范围</label>
            <select
              value={scanLimit}
              onChange={(event) => setScanLimit(event.target.value)}
              disabled={scanning}
            >
              {[100, 250, 500, 1000, 2500, 5000].map((value) => (
                <option key={value} value={value}>
                  {value} 条
                </option>
              ))}
              <option value="all">全部（安全页数限制）</option>
            </select>
          </div>
          <button
            className="primary-button"
            onClick={() => void startScan()}
            disabled={scanning || refreshing}
          >
            <Zap size={19} />
            {scanning
              ? "扫描进行中"
              : cooldown > 0
                ? `使用 Snapshot 扫描（冷却 ${cooldown} 秒）`
                : "开始扫描"}
          </button>
          <div className="secondary-actions">
            <button
              onClick={() => {
                abortRef.current?.abort();
              }}
              disabled={!scanning}
            >
              <Square size={15} />
              停止扫描
            </button>
            <button
              onClick={() => void refreshSavedPrices()}
              disabled={scanning || refreshing || results.length === 0}
            >
              <RefreshCw size={15} />
              {refreshing ? "刷新中" : "刷新已保存商品价格"}
            </button>
          </div>
        </div>
      </section>

      <section className="stats-grid">
        <StatCard
          label="扫描 Listing"
          value={progress.fetchedListings}
          detail="本轮 CSFloat 原始挂单"
          icon={<Database size={18} />}
        />
        <StatCard
          label="唯一饰品"
          value={progress.uniqueItems}
          detail="本轮按完整名称去重"
        />
        <StatCard
          label="成功匹配国内价格"
          value={progress.matchedItems}
          detail={`已保存匹配 ${matchedAll.length}`}
        />
        <StatCard
          label="满足当前筛选"
          value={visibleResults.length}
          detail={`有利润 ${profitAll.length} · 最大 +¥${money(maxDiff)}`}
          positive
        />
        <StatCard
          label="成交量数据"
          value={turnoverTask?.database?.dailyVolumeAvailable ?? results.filter((item) => item.csqaqDailyVolume != null).length}
          detail={`可查询 ${turnoverTask?.database?.goodIdAvailable ?? results.filter((item) => item.csqaqGoodId != null).length}`}
        />
      </section>
      <section className="workbench-stats">
          <span>
          CSFloat <b>{csfloatStatusLabel(csfloatRuntime.status, sessionProvider.csfloatProvider, cooldown)}</b>
          {sessionProvider.csfloatFetchedAt != null && <small> · 数据 {formatDate(sessionProvider.csfloatFetchedAt)}</small>}
          {csfloatRuntime.diagnostics?.currentPublicIp && <small> · 出口 {csfloatRuntime.diagnostics.currentPublicIp}</small>}
          {cooldown > 0 && <small> · 冷却剩余 {cooldown}s</small>}
          {csfloatRuntime.diagnostics?.lastErrorType && <small> · 上次429原因 {csfloatRuntime.diagnostics.lastErrorType}</small>}
          {csfloatRuntime.diagnostics?.lastErrorAt != null && <small> · 上次429 {formatDate(csfloatRuntime.diagnostics.lastErrorAt)}</small>}
        </span>
        <span>
          国内价格 <b>{domesticProviderLabel(domesticProvider)}</b>
          {sessionProvider.domesticFetchedAt != null && <small> · 数据 {formatDate(sessionProvider.domesticFetchedAt)}</small>}
        </span>
        <span>
          数据库 <b>{results.length} 件</b>
        </span>
        <span>
          本轮新发现 <b>{merge.added}</b>
        </span>
        <span>
          本轮价格更新 <b>{merge.updated}</b>
        </span>
        <span>
          有利润商品 <b>{profitAll.length}</b>
        </span>
        <span>
          最近保存 <b>{lastScanAt ? formatDate(lastScanAt) : "--"}</b>
        </span>
      </section>
      <section className="progress-panel">
        <div className="progress-head">
          <span className={`phase-dot ${progress.phase}`} />
          <b>{progress.status}</b>
          <span>{progress.percent}%</span>
        </div>
        <div className="progress-track">
          <i style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="progress-metrics">
          <span>
            挂单 <b>{progress.fetchedListings}</b>
          </span>
          <span>
            唯一饰品 <b>{progress.uniqueItems}</b>
          </span>
          <span>
            已匹配 <b>{progress.matchedItems}</b>
          </span>
          <span>
            正价差 <b>{progress.qualifiedItems}</b>
          </span>
        </div>
      </section>
      {(error || warnings.length > 0) && (
        <div className={error ? "notice error" : "notice warning"}>
          <span>{error || warnings.join("；")}</span>
          {error && (
            <button onClick={() => void reloadResults()}>重试读取</button>
          )}
        </div>
      )}

      <section className="filter-panel">
        <div className="result-tabs">
          <button
            className={resultView === "all" ? "active" : ""}
            onClick={() => setResultView("all")}
          >
            全部匹配 <b>{matchedAll.length}</b>
          </button>
          <button
            className={resultView === "profit" ? "active" : ""}
            onClick={() => setResultView("profit")}
          >
            有利润 <b>{profitAll.length}</b>
          </button>
          <button
            className={resultView === "filtered" ? "active" : ""}
            onClick={() => setResultView("filtered")}
          >
            符合筛选 <b>{filteredResults.length}</b>
          </button>
        </div>
        <div className="filter-topline">
          <div>
            <h3>结果工作台</h3>
            <p>
              当前显示 {visibleResults.length} / 已保存 {results.length}
            </p>
          </div>
          <div className="result-management">
            {selected.size > 0 && (
              <button
                className="danger-action"
                onClick={() => void deleteItems([...selected])}
              >
                <Trash2 size={14} />
                删除所选 {selected.size}
              </button>
            )}
            <button
              onClick={() => {
                if (
                  results.length &&
                  window.confirm(
                    `确认清空全部 ${results.length} 个已保存商品？商品将进入恢复区。`,
                  )
                )
                  void deleteItems(results.map((item) => item.marketHashName));
              }}
            >
              <Trash2 size={14} />
              清空结果
            </button>
            <button disabled={!deletedCount} onClick={() => void restoreAll()}>
              <RotateCcw size={14} />
              恢复已删除 {deletedCount || ""}
            </button>
          </div>
        </div>
        <div className="volume-toolbar">
          <button
            onClick={() => void startTurnoverEnrichment()}
            disabled={turnoverTask?.status === "running"}
          >
            <RefreshCw size={14} />
            {turnoverTask?.status === "running" ? `日成交量补全 ${turnoverTask.completed} / ${turnoverTask.total}` : "补全日成交量"}
          </button>
          <span>{turnoverTask?.message ?? "CSQAQ 商品级日成交量；不等同于 BUFF 或悠悠平台成交量"}</span>
        </div>
        <div className="filter-grid">
          <label className="search-field">
            <span>搜索全部已保存商品</span>
            <div>
              <Search size={16} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="英文名、中文名或 marketHashName"
              />
            </div>
          </label>
          <FilterSelect
            label="比较条件"
            value={comparisonMode}
            onChange={setComparisonMode}
            options={[
              ["any", "低于任意平台"],
              ["both", "同时低于两平台"],
              ["buff", "仅低于 BUFF"],
              ["youpin", "仅低于悠悠有品"],
            ]}
          />
          <FilterSelect
            label="品类"
            value={category}
            onChange={setCategory}
            options={categories}
          />
          <FilterSelect
            label="价格依据"
            value={priceSource}
            onChange={setPriceSource}
            options={[
              ["csfloat", "CSFloat 人民币"],
              ["buff", "BUFF 售价"],
              ["youpin", "悠悠有品售价"],
            ]}
          />
          <NumberField
            label="最低价格 ¥"
            value={minPrice}
            onChange={setMinPrice}
          />
          <NumberField
            label="最高价格 ¥"
            value={maxPrice}
            onChange={setMaxPrice}
          />
          <NumberField
            label="最低利润 ¥"
            value={minDiff}
            onChange={setMinDiff}
          />
          <NumberField
            label="最低利润率 %"
            value={minPercent}
            onChange={setMinPercent}
          />
          <NumberField
            label="最低日成交量"
            value={minDailyVolume}
            onChange={setMinDailyVolume}
          />
          <FilterSelect
            label="排序"
            value={sortBy}
            onChange={setSortBy}
            options={[
              ["diffPercentDesc", "利润率最高"],
              ["diffDesc", "利润金额最高"],
              ["csAsc", "CSFloat 价格最低"],
              ["csqaqVolumeDesc", "日成交量最高"],
              ["csqaqVolumeAsc", "日成交量最低"],
              ["firstSeenDesc", "最新发现"],
              ["updatedDesc", "最近更新"],
              ["recent", "Listing 最新"],
            ]}
          />
        </div>
      </section>

      <section className="results-panel">
        {pageResults.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="selection-column">
                      <input
                        aria-label="选择本页全部商品"
                        type="checkbox"
                        checked={pageResults.every((item) =>
                          selected.has(item.marketHashName),
                        )}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? new Set([
                                  ...selected,
                                  ...pageResults.map(
                                    (item) => item.marketHashName,
                                  ),
                                ])
                              : new Set(
                                  [...selected].filter(
                                    (name) =>
                                      !pageResults.some(
                                        (item) => item.marketHashName === name,
                                      ),
                                  ),
                                ),
                          )
                        }
                      />
                    </th>
                    <th className="item-column">商品</th>
                    <th className="numeric">CSFloat 成本</th>
                    <th className="numeric">BUFF</th>
                    <th className="numeric">悠悠有品</th>
                    <th className="numeric">日成交量</th>
                    <th className="numeric">套利</th>
                    <th>状态 / 时间</th>
                    <th className="action-column">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pageResults.map((item) => (
                    <ResultRow
                      key={item.marketHashName}
                      item={item}
                      pendingTurnovers={pendingTurnovers}
                      now={clock}
                      selected={selected.has(item.marketHashName)}
                      isNew={Boolean(
                        lastScanAt &&
                        item.firstSeenAt &&
                        item.firstSeenAt >= lastScanAt,
                      )}
                      onSelect={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(item.marketHashName);
                          else next.delete(item.marketHashName);
                          return next;
                        })
                      }
                      onDelete={() => void deleteItems([item.marketHashName])}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={safePage}
              totalPages={totalPages}
              pageSize={pageSize}
              total={visibleResults.length}
              onPage={setPage}
              onPageSize={setPageSize}
            />
          </>
        ) : (
          <div className="empty-state">
            <div>
              <Search size={23} />
            </div>
            <h3>
              {results.length ? "没有符合当前视图的结果" : "等待第一次扫描"}
            </h3>
            <p>
              {results.length
                ? "切换到全部匹配，或放宽筛选条件。"
                : "选择扫描范围后点击开始扫描；结果会永久保存。"}
            </p>
          </div>
        )}
      </section>
      <footer>
        在售数量与 CSQAQ 日成交量是不同指标；日成交量为商品级数据，不代表 BUFF 或悠悠有品各自成交量。
      </footer>
    </main>
  );
}

function ResultRow({
  item,
  pendingTurnovers,
  now,
  selected,
  isNew,
  onSelect,
  onDelete,
}: {
  item: ScanResult;
  pendingTurnovers: Set<string>;
  now: number;
  selected: boolean;
  isNew: boolean;
  onSelect: (value: boolean) => void;
  onDelete: () => void;
}) {
  const [imageIndex, setImageIndex] = useState(0);
  const images = useMemo(
    () => buildItemImageCandidates(...(item.imageUrls ?? []), item.iconUrl),
    [item.imageUrls, item.iconUrl],
  );
  const image = images[imageIndex];
  const positive = (item.bestDiff ?? 0) > 0;
  return (
    <tr>
      <td className="selection-column">
        <input
          aria-label={`选择 ${item.marketHashName}`}
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelect(event.target.checked)}
        />
      </td>
      <td className="item-column">
        <div className="item-cell">
          <div className="item-image">
            {image ? (
              <Image
                src={image}
                alt={item.marketHashName}
                width={144}
                height={144}
                loading="lazy"
                unoptimized
                onError={() => setImageIndex((value) => value + 1)}
              />
            ) : (
              <span>暂无图片</span>
            )}
          </div>
          <div className="item-copy">
            <b>{item.itemName || appearanceName(item.marketHashName)}</b>
            <small>
              {item.wearName || "无外观等级"} · Float{" "}
              {item.floatValue == null ? "--" : item.floatValue.toFixed(8)}
            </small>
            <div className="badges">
              {isNew && <em>NEW</em>}
              {item.isStatTrak && <em className="stattrak">StatTrak™</em>}
              {item.isSouvenir && <em className="souvenir">Souvenir</em>}
              {item.isDoubleLow && <em>双平台低价</em>}
            </div>
          </div>
        </div>
      </td>
      <td className="numeric price-primary">
        <b>¥{money(item.csfloatCny)}</b>
        <small>
          ${money(item.csfloatUsd)} · {sourceLabel(item.csfloatSource)}
        </small>
        {item.csfloatPriceChange != null && item.csfloatPriceChange !== 0 && (
          <small
            className={item.csfloatPriceChange < 0 ? "price-down" : "price-up"}
          >
            {item.csfloatPriceChange < 0 ? "↓" : "↑"} ¥
            {money(Math.abs(item.csfloatPriceChange))}
          </small>
        )}
      </td>
      <MarketCell
        price={item.buff}
      />
      <MarketCell
        price={item.youpin}
      />
      <TurnoverCell item={item} pending={pendingTurnovers.has(item.marketHashName)} now={now} />
      <td className={`numeric diff-cell ${positive ? "positive" : ""}`}>
        <b>
          {item.bestDiff == null
            ? "--"
            : `${item.bestDiff >= 0 ? "+" : "-"}¥${money(Math.abs(item.bestDiff))}`}
        </b>
        <small>
          {item.bestDiffPercent == null
            ? "--"
            : `${item.bestDiffPercent >= 0 ? "+" : ""}${money(item.bestDiffPercent)}% · ${item.bestPlatform === "buff" ? "BUFF" : item.bestPlatform === "youpin" ? "悠悠有品" : "不可比"}`}
        </small>
      </td>
      <td>
        <div className="status-cell">
          <b>{statusLabel(item)}</b>
          <span>
            更新于 {relativeTime(item.lastPriceUpdateAt ?? item.dataUpdatedAt)}
          </span>
          <small
            title={`首次发现 ${formatDate(item.firstSeenAt)}；最后扫描到 ${formatDate(item.lastSeenAt)}`}
          >
            首次 {formatDate(item.firstSeenAt)}
            <br />
            最后 {formatDate(item.lastSeenAt)}
            <br />
            CSFloat {formatDate(item.csfloatFetchedAt)} · 国内 {formatDate(Math.max(item.buff?.fetchedAt ?? 0, item.youpin?.fetchedAt ?? 0) || null)}
          </small>
        </div>
      </td>
      <td className="action-column">
        <div className="row-actions">
          <a href={item.listingUrl} target="_blank" rel="noopener noreferrer">
            CSFloat <ArrowUpRight size={12} />
          </a>
          {item.buffUrl && (
            <a href={item.buffUrl} target="_blank" rel="noopener noreferrer">
              BUFF <ArrowUpRight size={12} />
            </a>
          )}
          {item.youpinUrl && (
            <a href={item.youpinUrl} target="_blank" rel="noopener noreferrer">
              悠悠 <ArrowUpRight size={12} />
            </a>
          )}
          <button className="delete-row" onClick={onDelete}>
            <Trash2 size={13} />
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}

function MarketCell({
  price,
}: {
  price: ScanResult["buff"];
}) {
  return (
    <td className="numeric market-price">
      <b>{price ? `¥${money(price.sellPrice)}` : "--"}</b>
      <small>
        求购 {price?.bidPrice == null ? "--" : `¥${money(price.bidPrice)}`} ·
        在售 {price?.sellCount ?? "--"}
      </small>
    </td>
  );
}

function TurnoverCell({ item, pending, now }: { item: ScanResult; pending: boolean; now: number }) {
  const fetchedAt = item.csqaqVolumeFetchedAt;
  const periodTimestamp = item.csqaqVolumePeriodAt ? Date.parse(item.csqaqVolumePeriodAt) : Number.NaN;
  const stale = Boolean(
    (fetchedAt && now - fetchedAt > 6 * 60 * 60 * 1000)
    || (Number.isFinite(periodTimestamp) && now - periodTimestamp > 36 * 60 * 60 * 1000),
  );
  const period = item.csqaqVolumePeriodAt ? formatDate(item.csqaqVolumePeriodAt) : "统计日未知";
  const title = `数据源：CSQAQ\n日成交量：${item.csqaqDailyVolume ?? "--"}\n统计日期：${item.csqaqVolumePeriodAt ?? "--"}\n获取时间：${formatDate(fetchedAt)}`;
  return (
    <td className="numeric turnover-cell" title={title}>
      <b>{item.csqaqDailyVolume ?? (pending && !fetchedAt ? "..." : "--")}</b>
      <small>{!fetchedAt ? (pending ? "正在获取" : "等待补全") : `CSQAQ · ${stale ? "STALE" : "LIVE"}`}</small>
      {fetchedAt && <small>{period}</small>}
    </td>
  );
}

function Pagination({
  page,
  totalPages,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  totalPages: number;
  pageSize: number;
  total: number;
  onPage: (value: number) => void;
  onPageSize: (value: number) => void;
}) {
  return (
    <div className="pagination">
      <span>共 {total} 条</span>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        上一页
      </button>
      <b>
        {page} / {totalPages}
      </b>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        下一页
      </button>
      <select
        value={pageSize}
        onChange={(event) => onPageSize(Number(event.target.value))}
      >
        {[50, 100, 200].map((value) => (
          <option key={value} value={value}>
            每页 {value}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  icon,
  positive = false,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon?: React.ReactNode;
  positive?: boolean;
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <strong className={positive ? "positive" : ""}>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[][];
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="不限"
      />
    </label>
  );
}
async function readNdjson(
  stream: ReadableStream<Uint8Array>,
  handler: (event: StreamEvent) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines)
      if (line.trim()) handler(JSON.parse(line) as StreamEvent);
  }
}
function numberOrUndefined(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}
function appearanceName(value: string): string {
  return value.replace(/ \([^)]*\)$/, "");
}
function money(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}
function formatDate(value?: number | string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--"
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function relativeTime(value?: number | string | null): string {
  if (!value) return "--";
  const delta = Math.max(0, Date.now() - new Date(value).getTime());
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return formatDate(value);
}
function sourceLabel(source?: string, status?: string): string {
  if (status === "stale") return "STALE";
  if (source?.includes("cache") || status === "cache") return "CACHE";
  if (source?.includes("csqaq")) return "CSQAQ LIVE";
  if (source?.includes("steamdt")) return "STEAMDT FALLBACK";
  return source?.toUpperCase() ?? "LIVE";
}
function statusLabel(item: ScanResult): string {
  if (item.snapshotStatus === "unavailable") return "UNAVAILABLE";
  if (
    item.snapshotStatus === "partial" ||
    item.buff?.status === "stale" ||
    item.youpin?.status === "stale"
  )
    return "STALE / PARTIAL";
  if (
    item.buff?.source?.includes("cache") ||
    item.youpin?.source?.includes("cache")
  )
    return "CACHE";
  return "LIVE";
}
function domesticProviderLabel(provider: ProviderStatus): string {
  if (provider === "csqaq" || provider === "CSQAQ" || provider === "CSQAQ_LIVE") return "CSQAQ · LIVE";
  if (provider === "CACHE") return "CSQAQ · CACHE";
  if (provider === "CSQAQ_CACHE") return "CSQAQ · CACHE";
  if (provider === "CSQAQ_AUTH_RECOVERED") return "CSQAQ · AUTH RECOVERED";
  if (provider === "CSQAQ_AUTH_ERROR") return "CSQAQ · AUTH ERROR";
  if (provider === "CSQAQ_RATE_LIMITED") return "CSQAQ · RATE LIMITED";
  if (provider === "CSQAQ_UNAVAILABLE") return "CSQAQ · UNAVAILABLE";
  if (provider === "steamdt-fallback" || provider === "STEAMDT_FALLBACK") return "SteamDT · FALLBACK";
  if (provider === "steamdt" || provider === "STEAMDT") return "SteamDT · DIRECT";
  return "等待本轮状态";
}
function csfloatStatusLabel(runtime?: string, session?: string, cooldownSeconds = 0): string {
  if (cooldownSeconds > 0 && (!runtime || runtime === "CSFLOAT_LIVE")) return "COOLDOWN";
  switch (runtime) {
    case "CSFLOAT_LIVE": return "ONLINE";
    case "CSFLOAT_RATE_LIMITED": return "RATE LIMITED";
    case "CSFLOAT_MULTI_IP_BLOCKED": return "MULTI-IP BLOCKED";
    case "CSFLOAT_IP_CHANGED": return "IP CHANGED";
    case "CSFLOAT_PROBE": return "PROBE";
    case "CSFLOAT_SNAPSHOT": return "SNAPSHOT";
    case "CSFLOAT_UNAVAILABLE": return "UNAVAILABLE";
    default: return session ?? (cooldownSeconds > 0 ? "RATE LIMITED" : "等待本轮状态");
  }
}
function normalizeSession(value: unknown): Partial<ScanSessionState> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  if (typeof source.csfloatProvider === "string") return source as Partial<ScanSessionState>;
  // Compatibility with schema-6 sessions written before the explicit type.
  return {
    csfloatProvider: source.csfloat === "CSFLOAT_SNAPSHOT" ? "SNAPSHOT" : source.csfloat === "CSFLOAT_LIVE" ? "LIVE" : undefined,
    domesticProvider: source.domestic === "CSQAQ_CACHE" ? "CACHE" : source.domestic === "STEAMDT_FALLBACK" ? "STEAMDT_FALLBACK" : source.domestic === "csqaq" ? "CSQAQ" : undefined,
    csfloatFetchedAt: typeof source.csfloatFetchedAt === "number" ? source.csfloatFetchedAt : undefined,
    domesticFetchedAt: typeof source.domesticFetchedAt === "number" ? source.domesticFetchedAt : undefined,
    savedAt: typeof source.savedAt === "number" ? source.savedAt : undefined,
  };
}
function domesticProviderFromSession(session?: Partial<ScanSessionState>): ProviderStatus | null {
  const provider = session?.domesticProvider;
  return provider === "CSQAQ" || provider === "STEAMDT_FALLBACK" || provider === "STEAMDT" || provider === "CACHE" || provider === "ERROR" || provider === "MOCK" ? provider : null;
}
