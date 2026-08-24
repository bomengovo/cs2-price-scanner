import { getProviderState, saveProviderState, type ProviderState } from "./db";
import { getCsqaqHeaders, getServerSecret } from "./env";
import { ApiError } from "./http";
import fs from "node:fs";
import path from "node:path";

const bindEndpoint = "https://api.csqaq.com/api/v1/sys/bind_local_ip";
const globalKey = "__cs2CsqaqBindFlightV1" as const;
const preflightKey = "__cs2CsqaqBindPreflightStartedV1" as const;
const runtime = globalThis as typeof globalThis & { [globalKey]?: Promise<ProviderState>; [preflightKey]?: boolean };

export type CsqaqAuthStatus = "CSQAQ_LIVE" | "CSQAQ_BINDING" | "CSQAQ_AUTH_RECOVERING" | "CSQAQ_AUTH_RECOVERED" | "CSQAQ_AUTH_ERROR" | "CSQAQ_RATE_LIMITED" | "CSQAQ_UNAVAILABLE";

export function csqaqBindCooldownMs(): number {
  const configured = Number(process.env.CSQAQ_BIND_COOLDOWN_MS ?? 600_000);
  return Math.max(600_000, Number.isFinite(configured) ? configured : 600_000);
}

export function getCsqaqAuthState(): ProviderState {
  return getProviderState("csqaq");
}

export function isCsqaqAuthCircuitOpen(): boolean {
  return getCsqaqAuthState().status === "CSQAQ_AUTH_ERROR";
}

export function assertCsqaqAuthAvailable(): void {
  const state = getCsqaqAuthState();
  if (state.status === "CSQAQ_AUTH_ERROR") throw new ApiError("CSQAQ 授权恢复失败，已停止本轮请求以避免重复失败", 401);
}

export async function ensureCsqaqIpBound(options: { force?: boolean; recovering?: boolean } = {}): Promise<ProviderState> {
  const token = getServerSecret("CSQAQ_API_TOKEN");
  if (!token) return saveProviderState("csqaq", { status: "CSQAQ_UNAVAILABLE", lastFailureAt: Date.now(), message: "CSQAQ Token 未配置" });
  const current = getCsqaqAuthState();
  if (!options.force && current.lastBindAt && Date.now() - current.lastBindAt < csqaqBindCooldownMs()) return current;
  if (runtime[globalKey]) return runtime[globalKey]!;
  const task = (async () => {
    saveProviderState("csqaq", { status: options.recovering ? "CSQAQ_AUTH_RECOVERING" : "CSQAQ_BINDING", message: "正在绑定当前服务出口 IP" });
    const startedAt = Date.now();
    try {
      const response = await fetch(bindEndpoint, { method: "POST", headers: getCsqaqHeaders(token), cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const body = await response.json().catch(() => ({})) as { code?: number; msg?: string };
      if (!response.ok || body.code !== 200) throw new Error(`HTTP ${response.status}${body.msg ? `: ${body.msg}` : ""}`);
      const state = saveProviderState("csqaq", { status: options.recovering ? "CSQAQ_AUTH_RECOVERED" : "CSQAQ_LIVE", lastBindAt: Date.now(), lastSuccessAt: Date.now(), retryAt: null, consecutiveFailures: 0, message: `IP 绑定成功，耗时 ${Date.now() - startedAt}ms` });
      logProviderEvent("csqaq", "bind_local_ip", state.status, Date.now() - startedAt, options.recovering ? 1 : 0);
      return state;
    } catch (error) {
      const state = saveProviderState("csqaq", { status: "CSQAQ_AUTH_ERROR", lastFailureAt: Date.now(), consecutiveFailures: current.consecutiveFailures + 1, message: error instanceof Error ? `IP 绑定失败：${error.message}` : "IP 绑定失败" });
      logProviderEvent("csqaq", "bind_local_ip", state.status, Date.now() - startedAt, options.recovering ? 1 : 0);
      return state;
    } finally { runtime[globalKey] = undefined; }
  })();
  runtime[globalKey] = task;
  return task;
}

export async function rebindCsqaqIp(): Promise<ProviderState> {
  return ensureCsqaqIpBound({ force: true, recovering: true });
}

/** Executes an API call at most twice: original request, then one post-bind retry. */
export async function withCsqaqAuthRecovery<T>(request: () => Promise<T>): Promise<T> {
  assertCsqaqAuthAvailable();
  try {
    const response = await request();
    saveProviderState("csqaq", { status: "CSQAQ_LIVE", lastSuccessAt: Date.now(), retryAt: null, consecutiveFailures: 0, message: null });
    return response;
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error;
    saveProviderState("csqaq", { status: "CSQAQ_AUTH_RECOVERING", lastFailureAt: Date.now(), message: `收到 HTTP ${error.status}，正在单飞恢复` });
    const bound = await rebindCsqaqIp();
    if (bound.status === "CSQAQ_AUTH_ERROR") throw error;
    try {
      const response = await request();
      saveProviderState("csqaq", { status: "CSQAQ_AUTH_RECOVERED", lastSuccessAt: Date.now(), retryAt: null, consecutiveFailures: 0, message: "绑定后重试成功" });
      return response;
    } catch (retryError) {
      if (retryError instanceof ApiError && (retryError.status === 401 || retryError.status === 403))
        saveProviderState("csqaq", { status: "CSQAQ_AUTH_ERROR", lastFailureAt: Date.now(), consecutiveFailures: getCsqaqAuthState().consecutiveFailures + 1, message: `绑定后重试仍为 HTTP ${retryError.status}` });
      throw retryError;
    }
  }
}

export function startCsqaqBindPreflight(): void {
  if (process.env.CSQAQ_AUTO_BIND_IP === "false") return;
  if (runtime[preflightKey]) return;
  runtime[preflightKey] = true;
  void ensureCsqaqIpBound().catch(() => undefined);
}

function logProviderEvent(provider: string, endpoint: string, status: string, durationMs: number, retry: number): void {
  try {
    const directory = path.join(process.cwd(), "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "provider-api.log"), `${new Date().toISOString()} provider=${provider} endpoint=${endpoint} status=${status} durationMs=${durationMs} retry=${retry}\n`, "utf8");
  } catch { /* diagnostics must never change scanner behavior */ }
}
