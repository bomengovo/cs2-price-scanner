import { getLatestCsfloatSnapshot, getProviderState, getRateState, saveProviderState, saveRateState } from "../db";
import { ProviderApiError, parseRetryAfter } from "../provider-error";
import { recordApiUsage } from "./api-usage";
import { csfloatFetch, csfloatMultiIpCooldownMs, ensureCsfloatEgressStable, getCsfloatNetworkDiagnostics, isCsfloatMultiIp429, noteCsfloatHttpResult } from "../csfloat-network";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_INTERVAL_MS = 1_500;
const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000] as const;
let queue: Promise<void> = Promise.resolve();

function minIntervalMs(): number {
  const configured = Number(process.env.CSFLOAT_MIN_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  return process.env.NODE_ENV === "production" ? Math.max(1_500, configured || 0) : Math.max(0, configured || 0);
}

export function csfloatStatus(): { blocked: boolean; remainingMs: number; lastRequestAt: number; blockedUntil: number; status: "CSFLOAT_LIVE" | "CSFLOAT_RATE_LIMITED" | "CSFLOAT_MULTI_IP_BLOCKED" | "CSFLOAT_IP_CHANGED" | "CSFLOAT_PROBE" | "CSFLOAT_SNAPSHOT" | "CSFLOAT_UNAVAILABLE"; snapshotFetchedAt: number | null; retryAt: number | null; consecutiveFailures: number; diagnostics: ReturnType<typeof getCsfloatNetworkDiagnostics> } {
  const state = getRateState("csfloat", "listings");
  const now = Date.now();
  const blocked = state.blockedUntil > now;
  const snapshot = getLatestCsfloatSnapshot();
  const provider = getProviderState("csfloat");
  const recoveryStatuses = new Set(["CSFLOAT_RATE_LIMITED", "CSFLOAT_MULTI_IP_BLOCKED", "CSFLOAT_IP_CHANGED"]);
  const status = blocked && provider.status === "CSFLOAT_MULTI_IP_BLOCKED" ? "CSFLOAT_MULTI_IP_BLOCKED" : blocked && provider.status === "CSFLOAT_IP_CHANGED" ? "CSFLOAT_IP_CHANGED" : blocked ? "CSFLOAT_RATE_LIMITED" : provider.status === "CSFLOAT_LIVE" ? "CSFLOAT_LIVE" : recoveryStatuses.has(provider.status) ? "CSFLOAT_PROBE" : snapshot ? "CSFLOAT_SNAPSHOT" : "CSFLOAT_UNAVAILABLE";
  return { blocked, remainingMs: Math.max(0, state.blockedUntil - now), blockedUntil: blocked ? state.blockedUntil : 0, lastRequestAt: state.lastRequestAt, status, snapshotFetchedAt: snapshot?.fetchedAt ?? null, retryAt: blocked ? state.blockedUntil : provider.retryAt, consecutiveFailures: provider.consecutiveFailures, diagnostics: getCsfloatNetworkDiagnostics() };
}

/** True when a previous 429/IP failure ended but recovery has not been verified yet. */
export function csfloatNeedsProbe(): boolean {
  const state = csfloatStatus();
  return state.status === "CSFLOAT_PROBE" || (!state.blocked && (state.status === "CSFLOAT_RATE_LIMITED" || state.status === "CSFLOAT_MULTI_IP_BLOCKED" || state.status === "CSFLOAT_IP_CHANGED"));
}

export async function scheduleCsfloatListings(options: {
  url: string; headers: HeadersInit; signal?: AbortSignal; sessionId: string; page: number; caller: string; probe?: boolean;
}): Promise<Response> {
  const task = queue.then(async () => {
    // Cooldown removed: always clear any persisted block so the API is reachable.
    saveRateState("csfloat", "listings", { blockedUntil: 0 });
    const state = csfloatStatus();
    const wait = Math.max(0, state.lastRequestAt + minIntervalMs() - Date.now());
    if (wait) await abortableDelay(wait, options.signal);
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    saveRateState("csfloat", "listings", { lastRequestAt: startedAt });
    try {
      const response = await csfloatFetch(options.url, { headers: options.headers, signal: options.signal, cache: "no-store" });
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      recordApiUsage(options.sessionId, "csfloat-listings", { status: response.status, durationMs: Date.now() - startedAt, retryAfterMs: retryAfterMs ?? undefined, page: options.page, requestId, caller: options.caller });
      if (response.status === 429) {
        // Do not enter a long cooldown; log the failure and surface a plain error so the
        // caller can decide whether to fall back to a snapshot.
        const rejected = await logRejectedResponse(requestId, options, response);
        const multiIp = isCsfloatMultiIp429(rejected.body);
        noteCsfloatHttpResult(response, retryAfterMs ?? null, multiIp ? "too_many_requests_from_too_many_ips" : "rate_limited");
        saveProviderState("csfloat", { status: multiIp ? "CSFLOAT_MULTI_IP_BLOCKED" : "CSFLOAT_RATE_LIMITED", lastFailureAt: Date.now(), consecutiveFailures: getProviderState("csfloat").consecutiveFailures + 1, message: multiIp ? `检测到多 IP 429` : `HTTP 429` });
        throw new ProviderApiError("csfloat", "/api/v1/listings", 429, multiIp ? "CSFLOAT_MULTI_IP_BLOCKED" : "CSFLOAT_RATE_LIMIT", multiIp ? `CSFloat 检测到多公网 IP 请求。` : `CSFloat 返回 429。`, null);
      }
      if (response.status === 401 || response.status === 403) { await logRejectedResponse(requestId, options, response); noteCsfloatHttpResult(response, retryAfterMs ?? null, "auth_error"); saveProviderState("csfloat", { status: "CSFLOAT_UNAVAILABLE", lastFailureAt: Date.now(), consecutiveFailures: getProviderState("csfloat").consecutiveFailures + 1, message: `HTTP ${response.status}` }); throw new ProviderApiError("csfloat", "/api/v1/listings", response.status, "CSFLOAT_AUTH_ERROR", "CSFloat API认证失败。", null); }
      if (!response.ok) { await logRejectedResponse(requestId, options, response); noteCsfloatHttpResult(response, retryAfterMs ?? null, "server_error"); saveProviderState("csfloat", { status: "CSFLOAT_UNAVAILABLE", lastFailureAt: Date.now(), consecutiveFailures: getProviderState("csfloat").consecutiveFailures + 1, message: `HTTP ${response.status}` }); throw new ProviderApiError("csfloat", "/api/v1/listings", response.status, "CSFLOAT_SERVER_ERROR", `CSFloat 请求失败（HTTP ${response.status}）。`, null); }
      saveRateState("csfloat", "listings", { blockedUntil: 0 });
      saveProviderState("csfloat", { status: "CSFLOAT_LIVE", lastSuccessAt: Date.now(), retryAt: null, consecutiveFailures: 0, message: null });
      noteCsfloatHttpResult(response, retryAfterMs ?? null);
      return response;
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      recordApiUsage(options.sessionId, "csfloat-listings", { status: null, durationMs: Date.now() - startedAt, page: options.page, requestId, caller: options.caller });
      saveProviderState("csfloat", { status: "CSFLOAT_UNAVAILABLE", lastFailureAt: Date.now(), consecutiveFailures: getProviderState("csfloat").consecutiveFailures + 1, message: "网络错误" });
      throw new ProviderApiError("csfloat", "/api/v1/listings", null, "NETWORK_ERROR", error instanceof Error ? `CSFloat 网络错误：${error.message}` : "CSFloat 网络错误。", null);
    }
  });
  queue = task.then(() => undefined, () => undefined);
  return task;
}

async function logRejectedResponse(requestId: string, options: { url: string; sessionId: string; page: number; caller: string; probe?: boolean }, response: Response): Promise<{ body: string }> {
  try {
    const text = (await response.clone().text()).slice(0, 1000).replace(/[\r\n]+/g, " ");
    const headers = Object.fromEntries(["retry-after", "content-type", "server", "cf-ray", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"].map((name) => [name, response.headers.get(name)]).filter(([, value]) => value));
    const directory = path.join(process.cwd(), "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "provider-api.log"), `${new Date().toISOString()} [CSFLOAT HTTP] session=${options.sessionId} request=${requestId} caller=${options.caller} probe=${options.probe ? 1 : 0} page=${options.page} url=${options.url} status=${response.status} statusText=${JSON.stringify(response.statusText)} headers=${JSON.stringify(headers)} network=${JSON.stringify(getCsfloatNetworkDiagnostics())} bodyPrefix=${JSON.stringify(text)}\n`, "utf8");
    return { body: text };
  } catch { return { body: "" }; }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true }); });
}
