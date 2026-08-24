import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import fs from "node:fs";
import path from "node:path";
import { getProviderState, getRateState, saveProviderState, saveRateState } from "./db";

export type CsfloatNetworkDiagnostics = {
  proxyEnabled: boolean;
  proxyAddress: string | null;
  startupPublicIp: string | null;
  currentPublicIp: string | null;
  checkedAt: number | null;
  ipChanged: boolean;
  lastHttpStatus: number | null;
  lastCfRay: string | null;
  lastServer: string | null;
  lastRetryAfterMs: number | null;
  lastErrorType: string | null;
  lastErrorAt: number | null;
  lastError: string | null;
};

const PUBLIC_IP_URL = "https://api.ipify.org?format=json";
const directAgent = new Agent();
let activeProxy = "";
let activeDispatcher: Agent | ProxyAgent = directAgent;
let started = false;
let checkInFlight: Promise<CsfloatNetworkDiagnostics> | null = null;
let diagnostics: CsfloatNetworkDiagnostics = emptyDiagnostics();

function emptyDiagnostics(): CsfloatNetworkDiagnostics {
  return {
    proxyEnabled: false, proxyAddress: null, startupPublicIp: null, currentPublicIp: null,
    checkedAt: null, ipChanged: false, lastHttpStatus: null, lastCfRay: null, lastServer: null,
    lastRetryAfterMs: null, lastErrorType: null, lastErrorAt: null, lastError: null,
  };
}

/** The CSFloat route is intentionally independent from HTTP_PROXY/ALL_PROXY. */
export function getCsfloatProxy(): string | null {
  const value = process.env.CSFLOAT_PROXY?.trim();
  if (!value) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("CSFLOAT_PROXY 仅支持固定 HTTP/HTTPS 代理地址");
  return value;
}

export function getCsfloatNetworkDiagnostics(): CsfloatNetworkDiagnostics {
  return { ...diagnostics };
}

export function csfloatIpCheckIntervalMs(): number {
  const configured = Number(process.env.CSFLOAT_IP_CHECK_INTERVAL_MS ?? 60_000);
  return Math.max(10_000, Number.isFinite(configured) ? configured : 60_000);
}

export function csfloatMultiIpCooldownMs(): number {
  const configured = Number(process.env.CSFLOAT_MULTI_IP_COOLDOWN_MS ?? 1_800_000);
  return Math.max(60_000, Number.isFinite(configured) ? configured : 1_800_000);
}

export function shouldPauseCsfloatOnIpChange(): boolean {
  return process.env.CSFLOAT_PAUSE_ON_IP_CHANGE !== "false";
}

export async function csfloatFetch(url: string, init: RequestInit): Promise<Response> {
  // Vitest owns global fetch so existing deterministic integration tests never touch a proxy or public-IP service.
  if (process.env.NODE_ENV === "test") return fetch(url, init);
  const proxy = getCsfloatProxy();
  if (proxy !== activeProxy) {
    activeProxy = proxy ?? "";
    activeDispatcher = proxy ? new ProxyAgent({ uri: proxy }) : directAgent;
    const parsed = proxy ? new URL(proxy) : null;
    diagnostics = { ...diagnostics, proxyEnabled: Boolean(proxy), proxyAddress: parsed ? `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}` : null };
  }
  return undiciFetch(url, { ...init, dispatcher: activeDispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
}

/** Starts one non-blocking startup egress check and a background periodic IP monitor. */
export function startCsfloatNetworkMonitor(): void {
  if (started) return;
  started = true;
  void refreshCsfloatNetworkDiagnostics(true);
  startBackgroundIpMonitor();
}

const backgroundMonitorKey = Symbol.for("csfloat.background.ip.monitor");
let backgroundMonitorStarted = false;

function startBackgroundIpMonitor(): void {
  if (process.env.NODE_ENV === "test") return;
  if (backgroundMonitorStarted) return;
  const globalState = globalThis as typeof globalThis & { [backgroundMonitorKey]?: boolean };
  if (globalState[backgroundMonitorKey]) { backgroundMonitorStarted = true; return; }
  backgroundMonitorStarted = true;
  globalState[backgroundMonitorKey] = true;
  // The interval keeps the startup/current public IP fresh even while no scan is
  // running, so a VPN/Clash node switch is detected and CSFloat paused promptly.
  // `unref` keeps it from holding the process open by itself.
  const timer = setInterval(() => {
    void refreshCsfloatNetworkDiagnostics(false);
  }, csfloatIpCheckIntervalMs());
  if (typeof timer.unref === "function") timer.unref();
}

export async function ensureCsfloatEgressStable(): Promise<{ stable: boolean; diagnostics: CsfloatNetworkDiagnostics }> {
  const stale = !diagnostics.checkedAt || Date.now() - diagnostics.checkedAt >= csfloatIpCheckIntervalMs();
  if (stale) await refreshCsfloatNetworkDiagnostics(false);
  return { stable: !shouldPauseCsfloatOnIpChange() || !diagnostics.ipChanged, diagnostics: getCsfloatNetworkDiagnostics() };
}

export async function refreshCsfloatNetworkDiagnostics(force: boolean): Promise<CsfloatNetworkDiagnostics> {
  if (!force && diagnostics.checkedAt && Date.now() - diagnostics.checkedAt < csfloatIpCheckIntervalMs()) return getCsfloatNetworkDiagnostics();
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    try {
      const response = await csfloatFetch(PUBLIC_IP_URL, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`IP 服务 HTTP ${response.status}`);
      const body = await response.json() as { ip?: unknown };
      const ip = typeof body.ip === "string" && body.ip.trim() ? body.ip.trim() : null;
      if (!ip) throw new Error("IP 服务未返回地址");
      const needsStartup = !diagnostics.startupPublicIp;
      const startup = diagnostics.startupPublicIp ?? ip;
      const changed = Boolean(startup && startup !== ip);
      diagnostics = { ...diagnostics, startupPublicIp: startup, currentPublicIp: ip, checkedAt: Date.now(), ipChanged: changed, lastError: null };
      if (changed) {
        writeDiagnostic("IP_CHANGE", { startup, current: ip, proxy: diagnostics.proxyAddress });
        // Pause CSFloat immediately so a VPN/Clash node switch cannot keep
        // producing multi-IP 429s.  The scheduler re-checks stability before
        // the next request, so this persisted pause is belt-and-suspenders.
        if (shouldPauseCsfloatOnIpChange()) pauseCsfloatForIpChange(startup, ip);
      }
      else if (needsStartup) writeDiagnostic("IP_STARTUP", { current: ip, proxy: diagnostics.proxyAddress });
    } catch (error) {
      diagnostics = { ...diagnostics, checkedAt: Date.now(), lastError: error instanceof Error ? error.message : "公网 IP 检测失败" };
      writeDiagnostic("IP_CHECK_FAILED", { message: diagnostics.lastError, proxy: diagnostics.proxyAddress });
    } finally {
      checkInFlight = null;
    }
    return getCsfloatNetworkDiagnostics();
  })();
  return checkInFlight;
}

export function noteCsfloatHttpResult(response: Response, retryAfterMs: number | null, errorType: string | null = null): void {
  diagnostics = {
    ...diagnostics,
    lastHttpStatus: response.status,
    lastCfRay: response.headers.get("cf-ray"),
    lastServer: response.headers.get("server"),
    lastRetryAfterMs: retryAfterMs,
    lastErrorType: errorType,
    lastErrorAt: errorType ? Date.now() : null,
  };
}

export function isCsfloatMultiIp429(body: string): boolean {
  return /too\s+many\s+requests\s+from\s+too\s+many\s+ips/i.test(body);
}

export function resetCsfloatNetworkDiagnosticsForTest(seed: Partial<CsfloatNetworkDiagnostics> = {}): void {
  started = false;
  backgroundMonitorStarted = false;
  checkInFlight = null;
  diagnostics = { ...emptyDiagnostics(), ...seed };
}

/** Persists a CSFloat IP_CHANGED pause. Callers re-check stability before requests. */
export function pauseCsfloatForIpChange(startup: string, current: string): void {
  const cooldown = csfloatMultiIpCooldownMs();
  const blockedUntil = Math.max(getRateState("csfloat", "listings").blockedUntil, Date.now() + cooldown);
  saveRateState("csfloat", "listings", { blockedUntil });
  saveProviderState("csfloat", { status: "CSFLOAT_IP_CHANGED", lastFailureAt: Date.now(), retryAt: blockedUntil, consecutiveFailures: getProviderState("csfloat").consecutiveFailures, message: `检测到 CSFloat 出口公网 IP 变化（startup=${startup} current=${current}），已暂停请求` });
  writeDiagnostic("IP_CHANGE_PAUSED", { startup, current, proxy: diagnostics.proxyAddress });
}

function writeDiagnostic(event: string, details: Record<string, unknown>): void {
  try {
    const directory = path.join(process.cwd(), "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "provider-api.log"), `${new Date().toISOString()} [CSFLOAT][${event}] ${JSON.stringify(details)}\n`, "utf8");
  } catch { /* diagnostics must never interrupt scans */ }
}
