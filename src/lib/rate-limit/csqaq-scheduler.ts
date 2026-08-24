import fs from "node:fs";
import path from "node:path";
import { getRateState, saveRateState } from "../db";
import { ApiError } from "../http";
import { isCsqaqAuthCircuitOpen } from "../csqaq-ip-binding";

const DEFAULT_INTERVAL_MS = 1_100;
const DEFAULT_BLOCK_MS = 60_000;

export type CsqaqPriority = "high" | "medium" | "low";
export type CsqaqRequestKind = "CSQAQ_PRICE_BATCH" | "CSQAQ_INFO_GOOD";

type QueueItem = {
  key: string;
  kind: CsqaqRequestKind;
  priority: CsqaqPriority;
  sequence: number;
  signal?: AbortSignal;
  run: () => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

type SchedulerState = {
  queue: QueueItem[];
  draining: boolean;
  sequence: number;
  inFlight: Map<string, Promise<Response>>;
};

const globalKey = "__cs2CsqaqSchedulerV2" as const;
const globalState = globalThis as typeof globalThis & { [globalKey]?: SchedulerState };
const scheduler: SchedulerState = globalState[globalKey] ??= { queue: [], draining: false, sequence: 0, inFlight: new Map() };
const priorityWeight: Record<CsqaqPriority, number> = { high: 0, medium: 1, low: 2 };

export function csqaqMinIntervalMs(): number {
  const configured = Number(process.env.CSQAQ_MIN_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (process.env.NODE_ENV === "test") return Math.max(0, Number.isFinite(configured) ? configured : 0);
  return Math.max(DEFAULT_INTERVAL_MS, Number.isFinite(configured) ? configured : DEFAULT_INTERVAL_MS);
}

export function csqaqStatus(): { blocked: boolean; remainingMs: number; lastRequestAt: number; nextAllowedAt: number; blockedUntil: number; queued: number } {
  const state = getRateState("csqaq", "global");
  const legacy = getRateState("csqaq", "batch");
  const lastRequestAt = Math.max(state.lastRequestAt, legacy.lastRequestAt);
  const blockedUntil = Math.max(state.blockedUntil, legacy.blockedUntil);
  const now = Date.now();
  const nextAllowedAt = Math.max(lastRequestAt + csqaqMinIntervalMs(), blockedUntil);
  return { blocked: blockedUntil > now, remainingMs: Math.max(0, nextAllowedAt - now), lastRequestAt, nextAllowedAt, blockedUntil, queued: scheduler.queue.length };
}

export function scheduleCsqaqRequest(options: { key: string; kind: CsqaqRequestKind; priority: CsqaqPriority; signal?: AbortSignal; run: () => Promise<Response> }): Promise<Response> {
  const singleFlightKey = `${options.kind}:${options.key}`;
  const existing = scheduler.inFlight.get(singleFlightKey);
  if (existing) return existing.then((response) => response.clone());

  const task = new Promise<Response>((resolve, reject) => {
    scheduler.queue.push({ ...options, key: singleFlightKey, sequence: scheduler.sequence++, resolve, reject });
    void drainQueue();
  });
  scheduler.inFlight.set(singleFlightKey, task);
  void task.finally(() => scheduler.inFlight.delete(singleFlightKey)).catch(() => undefined);
  return task.then((response) => response.clone());
}

/** Compatibility wrapper for the price path. */
export function scheduleCsqaqBatch(options: { key: string; signal?: AbortSignal; run: () => Promise<Response> }): Promise<Response> {
  return scheduleCsqaqRequest({ ...options, kind: "CSQAQ_PRICE_BATCH", priority: "high" });
}

async function drainQueue(): Promise<void> {
  if (scheduler.draining) return;
  scheduler.draining = true;
  try {
    while (scheduler.queue.length) {
      if (isCsqaqAuthCircuitOpen()) {
        const error = new ApiError("CSQAQ 授权恢复失败，已停止队列", 401);
        for (const queued of scheduler.queue.splice(0)) queued.reject(error);
        return;
      }
      const status = csqaqStatus();
      if (status.remainingMs) await delay(status.remainingMs);
      scheduler.queue.sort((left, right) => priorityWeight[left.priority] - priorityWeight[right.priority] || left.sequence - right.sequence);
      const item = scheduler.queue.shift()!;
      if (item.signal?.aborted) { item.reject(new DOMException("Aborted", "AbortError")); continue; }
      const startedAt = Date.now();
      saveRateState("csqaq", "global", { lastRequestAt: startedAt });
      if (process.env.NODE_ENV !== "test") appendSchedulerLog(`${new Date(startedAt).toISOString()} event=REQUEST_START kind=${item.kind} priority=${item.priority} keyHash=${stableHash(item.key)} minIntervalMs=${csqaqMinIntervalMs()}`);
      try {
        const response = await item.run();
        saveRateState("csqaq", "global", { blockedUntil: 0 });
        item.resolve(response);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 429 || error.status === 503)) {
          const blockedUntil = Date.now() + (error.retryAfterMs ?? DEFAULT_BLOCK_MS);
          saveRateState("csqaq", "global", { blockedUntil });
          appendSchedulerLog(`${new Date().toISOString()} event=GLOBAL_COOLDOWN status=${error.status} blockedUntil=${blockedUntil}`);
        }
        item.reject(error);
      }
    }
  } finally {
    scheduler.draining = false;
    if (scheduler.queue.length) void drainQueue();
  }
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function appendSchedulerLog(line: string): void {
  try { const directory = path.join(process.cwd(), "logs"); fs.mkdirSync(directory, { recursive: true }); fs.appendFileSync(path.join(directory, "csqaq-scheduler.log"), `${line}\n`, "utf8"); } catch { /* diagnostics only */ }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
