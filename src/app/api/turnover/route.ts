import { NextResponse } from "next/server";
import { startTurnoverEnrichment, turnoverStatus } from "@/lib/turnover-enrichment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(turnoverStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { items?: unknown };
    const items = Array.isArray(body.items) ? body.items.slice(0, 50).flatMap((raw) => {
      const value = raw as { marketHashName?: unknown; csqaqGoodId?: unknown };
      const marketHashName = String(value.marketHashName ?? "").trim();
      const csqaqGoodId = Number(value.csqaqGoodId);
      return marketHashName && Number.isFinite(csqaqGoodId) && csqaqGoodId > 0 ? [{ marketHashName, csqaqGoodId }] : [];
    }) : [];
    return NextResponse.json(startTurnoverEnrichment(items), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "日成交量补全请求无效" }, { status: 400 });
  }
}
