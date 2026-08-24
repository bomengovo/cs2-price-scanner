import { refreshSavedPrices } from "@/lib/refresh-prices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const rawLimit = new URL(request.url).searchParams.get("limit");
    const limit = rawLimit == null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 5000)) return Response.json({ error: "刷新数量参数无效" }, { status: 400 });
    const output = await refreshSavedPrices(request.signal, limit);
    return Response.json(output, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "刷新已保存价格失败" }, { status: 502 });
  }
}
