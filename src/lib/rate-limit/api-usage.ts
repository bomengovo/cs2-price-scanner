import fs from "node:fs";
import path from "node:path";

export type ApiUsageEndpoint = "csfloat-listings" | "csfloat-item" | "csqaq-batch" | "csqaq-detail" | "csqaq-chart" | "steamdt-batch" | "steamdt-single" | "steamdt-base";
const counters = new Map<string, Map<ApiUsageEndpoint, number>>();

export function recordApiUsage(sessionId: string, endpoint: ApiUsageEndpoint, details: { status?: number | null; names?: number; durationMs?: number; retry?: number; retryAfterMs?: number; page?: number; cache?: "hit" | "miss"; requestId?: string; caller?: string } = {}): void {
  const session = counters.get(sessionId) ?? new Map<ApiUsageEndpoint, number>();
  session.set(endpoint, (session.get(endpoint) ?? 0) + 1);
  counters.set(sessionId, session);
  const provider = endpoint.startsWith("csfloat") ? "csfloat" : endpoint.startsWith("csqaq") ? "csqaq" : "steamdt";
  append(`${new Date().toISOString()} session=${sessionId} request=${details.requestId ?? "n/a"} caller=${details.caller ?? "n/a"} provider=${provider} endpoint=${endpoint} attempt=1 status=${details.status ?? "network_error"} durationMs=${details.durationMs ?? 0} retryAfterMs=${details.retryAfterMs ?? 0} source=live names=${details.names ?? 0} page=${details.page ?? 0}`);
}

export function flushApiUsage(sessionId: string): void {
  const current = counters.get(sessionId) ?? new Map<ApiUsageEndpoint, number>();
  append(`SCAN SESSION ${sessionId} CSFloat listings=${current.get("csfloat-listings") ?? 0} CSFloat item verify=${current.get("csfloat-item") ?? 0} CSQAQ batch=${current.get("csqaq-batch") ?? 0} CSQAQ detail=${current.get("csqaq-detail") ?? 0} CSQAQ chart=${current.get("csqaq-chart") ?? 0} SteamDT batch=${current.get("steamdt-batch") ?? 0} SteamDT single=${current.get("steamdt-single") ?? 0} SteamDT base=${current.get("steamdt-base") ?? 0}`);
  counters.delete(sessionId);
}

function append(line: string): void {
  try { const directory = path.join(process.cwd(), "logs"); fs.mkdirSync(directory, { recursive: true }); fs.appendFileSync(path.join(directory, "api-usage.log"), `${line}\n`, "utf8"); } catch { /* diagnostics only */ }
}
