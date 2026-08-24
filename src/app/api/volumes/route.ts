import { environmentSettings } from "@/lib/config";
import { getStoredSettings } from "@/lib/db";
import { getServerSecret } from "@/lib/env";
import { loadDailyVolumes, type VolumeLookupItem } from "@/lib/volume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  let items: VolumeLookupItem[];
  let cacheOnly = false;
  let metadataOnly = false;
  try {
    const body = await request.json() as { items?: unknown; cacheOnly?: boolean; metadataOnly?: boolean };
    if (!Array.isArray(body.items) || body.items.length > 50) throw new Error();
    cacheOnly = body.cacheOnly === true;
    metadataOnly = body.metadataOnly === true;
    items = body.items.flatMap((raw) => {
      const item = raw as Partial<VolumeLookupItem>;
      const marketHashName = String(item.marketHashName ?? "").trim();
      if (!marketHashName) return [];
      const parsedGoodId = item.csqaqGoodId == null ? null : Number(item.csqaqGoodId);
      return [{ marketHashName, csqaqGoodId: Number.isFinite(parsedGoodId) ? parsedGoodId : null,
        buffGoodsId: item.buffGoodsId == null ? null : String(item.buffGoodsId),
        youpinTemplateId: item.youpinTemplateId == null ? null : String(item.youpinTemplateId) }];
    });
  } catch {
    return Response.json({ error: "成交量请求参数无效（每批最多 50 条）" }, { status: 400 });
  }
  const settings = { ...environmentSettings(), ...getStoredSettings() };
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); } catch { closed = true; }
      };
      try {
        await loadDailyVolumes({
          items, cacheSeconds: settings.volumeCacheSeconds, apiToken: getServerSecret("CSQAQ_API_TOKEN"),
          cacheOnly, metadataOnly,
          onMetadata: (metadata) => send({ type: "metadata", metadata }),
          onResult: (result) => send({ type: "volume", result }),
        });
        send({ type: "done" });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "成交量加载失败" });
      } finally {
        if (!closed) { try { controller.close(); } catch { /* Client disconnected. */ } }
        closed = true;
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
