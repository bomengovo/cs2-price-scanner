import { NextResponse } from "next/server";
import { getLastScan } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Development-only, deliberately returns no credentials or request headers.
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const name = new URL(request.url).searchParams.get("marketHashName")?.trim();
  if (!name) return NextResponse.json({ error: "marketHashName is required" }, { status: 400 });
  const item = getLastScan()?.results.find((result) => result.marketHashName === name);
  if (!item) return NextResponse.json({ error: "No live scan result for this item" }, { status: 404 });
  return NextResponse.json({
    marketHashName: item.marketHashName,
    scanSessionId: item.scanSessionId,
    csfloat: { price: item.csfloatCny, listingId: item.csfloatListingId, fetchedAt: item.csfloatFetchedAt, source: item.csfloatSource },
    buff: item.buff && { price: item.buff.sellPrice, goodsId: item.buffGoodsId, providerUpdatedAt: item.buff.updatedAt, fetchedAt: item.buff.fetchedAt, source: item.buff.source, status: item.buff.status },
    youpin: item.youpin && { price: item.youpin.sellPrice, templateId: item.youpinTemplateId, providerUpdatedAt: item.youpin.updatedAt, fetchedAt: item.youpin.fetchedAt, source: item.youpin.source, status: item.youpin.status },
  }, { headers: { "Cache-Control": "no-store" } });
}
