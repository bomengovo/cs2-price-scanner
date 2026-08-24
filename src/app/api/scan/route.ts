import { runScan } from "@/lib/scanner";
import type { ScanRequest } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type ProgressSink = (value: unknown) => void;
type SharedScan = {
  promise: Promise<Awaited<ReturnType<typeof runScan>>>;
  controller: AbortController;
  subscribers: Set<ProgressSink>;
};
const inFlightScans = new Map<string, SharedScan>();

export async function POST(request: Request) {
  let body: ScanRequest;
  try {
    const raw = (await request.json()) as Partial<ScanRequest>;
    const limit = raw.limit === "all" ? "all" : Number(raw.limit ?? 100);
    if (limit !== "all" && (!Number.isFinite(limit) || limit <= 0))
      throw new Error();
    body = { limit, forceRefresh: Boolean(raw.forceRefresh) };
  } catch {
    return Response.json({ error: "扫描参数无效" }, { status: 400 });
  }
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        } catch {
          closed = true;
        }
      };
      try {
        const key = JSON.stringify({
          limit: body.limit,
          forceRefresh: body.forceRefresh,
        });
        let shared = inFlightScans.get(key);
        if (!shared) {
          const scanController = new AbortController();
          const subscribers = new Set<ProgressSink>();
          const promise = runScan(
            body,
            (progress) => {
              for (const subscriber of subscribers) {
                try {
                  subscriber({ type: "progress", progress });
                } catch {
                  subscribers.delete(subscriber);
                }
              }
            },
            scanController.signal,
          ).finally(() => inFlightScans.delete(key));
          shared = { promise, controller: scanController, subscribers };
          inFlightScans.set(key, shared);
        } else
          send({
            type: "progress",
            progress: {
              phase: "csfloat",
              percent: 1,
              fetchedListings: 0,
              uniqueItems: 0,
              matchedItems: 0,
              qualifiedItems: 0,
              buffComparable: 0,
              youpinComparable: 0,
              status: "正在复用相同范围的扫描会话",
            },
          });
        shared.subscribers.add(send);
        let released = false;
        const release = () => {
          if (released || !shared) return;
          released = true;
          shared.subscribers.delete(send);
          if (shared.subscribers.size === 0 && request.signal.aborted)
            shared.controller.abort();
        };
        request.signal.addEventListener("abort", release, { once: true });
        const output = await shared.promise;
        release();
        send({ type: "result", ...output });
      } catch (error) {
        const stopped =
          request.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        try {
          send({
            type: stopped ? "stopped" : "error",
            error: stopped
              ? "扫描已停止"
              : error instanceof Error
                ? error.message
                : "扫描失败",
          });
        } catch {
          /* 客户端已断开 */
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* 客户端已断开 */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
