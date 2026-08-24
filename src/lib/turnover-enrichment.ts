import fs from "node:fs";
import path from "node:path";
import { ApiError } from "./http";
import { isCsqaqAuthCircuitOpen } from "./csqaq-ip-binding";
import { CSQAQ_METADATA_TTL_MS, getCSQAQItemMetadata } from "./csqaq";
import { getCsqaqItemMetadata, getTurnoverCandidates, getTurnoverDatabaseStats, getTurnoverEnrichmentState, saveTurnoverEnrichmentState, type TurnoverEnrichmentState } from "./db";

type Candidate = { marketHashName: string; csqaqGoodId: number; fetchedAt: number | null };
type Runtime = { running: boolean; pending: Map<string, Candidate>; priority: string[] };
const runtimeKey = "__cs2TurnoverEnrichmentV1" as const;
const globalRuntime = globalThis as typeof globalThis & { [runtimeKey]?: Runtime };
const runtime: Runtime = globalRuntime[runtimeKey] ??= { running: false, pending: new Map(), priority: [] };

export function turnoverStatus(): TurnoverEnrichmentState & { database: ReturnType<typeof getTurnoverDatabaseStats> } {
  return { ...getTurnoverEnrichmentState(), database: getTurnoverDatabaseStats() };
}

export function startTurnoverEnrichment(priorityItems: Array<Pick<Candidate, "marketHashName" | "csqaqGoodId">> = []): TurnoverEnrichmentState {
  for (const item of priorityItems) {
    if (!item.marketHashName || !Number.isFinite(item.csqaqGoodId) || item.csqaqGoodId <= 0) continue;
    if (!runtime.priority.includes(item.marketHashName)) runtime.priority.push(item.marketHashName);
  }
  if (runtime.running) return getTurnoverEnrichmentState();

  const candidates = getTurnoverCandidates(CSQAQ_METADATA_TTL_MS);
  runtime.pending = new Map(candidates.map((item) => [item.marketHashName, item]));
  if (!candidates.length) {
    runtime.priority = [];
    return saveTurnoverEnrichmentState({ status: "completed", total: 0, completed: 0, populated: 0, realZero: 0, noData: 0, failures: 0, cacheHits: 0, rateLimited: 0, startedAt: Date.now(), message: "没有缺失或超过 6 小时 TTL 的 CSQAQ 日成交量" });
  }
  runtime.running = true;
  const state = saveTurnoverEnrichmentState({ status: "running", total: candidates.length, completed: 0, populated: 0, realZero: 0, noData: 0, failures: 0, cacheHits: 0, rateLimited: 0, startedAt: Date.now(), message: "CSQAQ 日成交量低优先级补全中" });
  appendLog(`event=START total=${candidates.length} priority=${runtime.priority.length}`);
  void runEnrichment();
  return state;
}

async function runEnrichment(): Promise<void> {
  try {
    while (runtime.pending.size) {
      const candidate = takeNext();
      if (!candidate) break;
      const before = getCsqaqItemMetadata(candidate.marketHashName);
      try {
        const metadata = await getCSQAQItemMetadata({ marketHashName: candidate.marketHashName, goodId: candidate.csqaqGoodId });
        const latest = getTurnoverEnrichmentState();
        const cacheHit = Boolean(before?.fetchedAt && before.fetchedAt >= Date.now() - CSQAQ_METADATA_TTL_MS);
        const volume = metadata?.turnoverNumber ?? null;
        const next = saveTurnoverEnrichmentState({
          status: "running", completed: latest.completed + 1, cacheHits: latest.cacheHits + Number(cacheHit),
          populated: latest.populated + Number(volume != null), realZero: latest.realZero + Number(volume === 0),
          noData: latest.noData + Number(volume == null), message: `正在补全 ${latest.completed + 1} / ${latest.total}`,
        });
        appendLog(`event=INFO_GOOD goodId=${candidate.csqaqGoodId} status=success turnover=${volume ?? "null"} periodAt=${metadata?.periodAt ?? "null"} completed=${next.completed}/${next.total}`);
      } catch (error) {
        const latest = getTurnoverEnrichmentState();
        const rateLimited = error instanceof ApiError && error.status === 429;
        const authBlocked = (error instanceof ApiError && (error.status === 401 || error.status === 403)) || isCsqaqAuthCircuitOpen();
        if (authBlocked) {
          runtime.pending.clear();
          saveTurnoverEnrichmentState({ status: "auth_error", completed: latest.completed, failures: latest.failures + 1,
            message: "CSQAQ 授权恢复失败，已停止日成交量队列，等待下次扫描恢复" });
          appendLog(`event=AUTH_ERROR goodId=${candidate.csqaqGoodId} queue=stopped`);
          return;
        }
        const next = saveTurnoverEnrichmentState({ status: rateLimited ? "rate_limited" : "running", completed: latest.completed + 1,
          failures: latest.failures + 1, rateLimited: latest.rateLimited + Number(rateLimited),
          message: rateLimited ? "CSQAQ 限流冷却中，队列将自动继续" : `补全失败，继续其他商品（${latest.completed + 1} / ${latest.total}）` });
        appendLog(`event=INFO_GOOD goodId=${candidate.csqaqGoodId} status=${rateLimited ? "429" : "failure"} completed=${next.completed}/${next.total}`);
      }
    }
    const latest = getTurnoverEnrichmentState();
    if (latest.status === "auth_error") return;
    saveTurnoverEnrichmentState({ status: "completed", message: `补全完成：有数据 ${latest.populated}，无数据 ${latest.noData}，失败 ${latest.failures}` });
    appendLog("event=COMPLETE");
  } catch {
    saveTurnoverEnrichmentState({ status: "failed", message: "补全任务意外停止；已完成数据已保存，可再次补全" });
    appendLog("event=FAILED");
  } finally {
    runtime.running = false;
    runtime.pending.clear();
    runtime.priority = [];
  }
}

function takeNext(): Candidate | null {
  while (runtime.priority.length) {
    const name = runtime.priority.shift()!;
    const candidate = runtime.pending.get(name);
    if (candidate) { runtime.pending.delete(name); return candidate; }
  }
  const next = runtime.pending.values().next().value as Candidate | undefined;
  if (!next) return null;
  runtime.pending.delete(next.marketHashName);
  return next;
}

function appendLog(line: string): void {
  try {
    const directory = path.join(process.cwd(), "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "csqaq-enrichment.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* Auxiliary diagnostics must not interrupt enrichment. */ }
}
