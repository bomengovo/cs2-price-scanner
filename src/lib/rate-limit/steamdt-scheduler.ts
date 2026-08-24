import { ApiError } from "../http";
import { getRateState, saveRateState } from "../db";

export const STEAMDT_BATCH_COOLDOWN_MS = 65_000;
let batchInFlight: Promise<"live" | "cache"> | null = null;

function cooldownMs(): number {
  const configured = Number(process.env.STEAMDT_BATCH_INTERVAL_MS ?? STEAMDT_BATCH_COOLDOWN_MS);
  return process.env.NODE_ENV === "test" ? Math.max(0, configured || 0) : Math.max(60_000, configured || STEAMDT_BATCH_COOLDOWN_MS);
}

export function steamDTBatchStatus(): { remainingMs: number; blocked: boolean; lastRequestAt: number } {
  const state = getRateState("steamdt", "batch");
  const until = Math.max(state.blockedUntil, state.lastRequestAt + cooldownMs());
  return { remainingMs: Math.max(0, until - Date.now()), blocked: state.blockedUntil > Date.now(), lastRequestAt: state.lastRequestAt };
}

/** Global single-flight scheduler. A cooldown is a cache decision, never a sleep-and-retry request. */
export async function scheduleSteamDTBatch(run: () => Promise<void>): Promise<"live" | "cache"> {
  if (batchInFlight) return batchInFlight;
  if (steamDTBatchStatus().remainingMs > 0) return "cache";
  batchInFlight = (async () => {
    saveRateState("steamdt", "batch", { lastRequestAt: Date.now(), blockedUntil: 0 });
    try { await run(); return "live" as const; }
    catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        saveRateState("steamdt", "batch", { blockedUntil: Date.now() + (error.retryAfterMs ?? cooldownMs()) });
        return "cache" as const;
      }
      throw error;
    } finally { batchInFlight = null; }
  })();
  return batchInFlight;
}
