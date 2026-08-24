import { NextResponse } from "next/server";
import { environmentSettings } from "@/lib/config";
import { getLastScan, getLatestScanSessionMetrics, getStoredSettings } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const saved = getLastScan();
  return NextResponse.json({
    results: saved?.results ?? [],
    lastScanAt: saved?.scannedAt ?? null,
    lastMetrics: getLatestScanSessionMetrics(),
    settings: { ...environmentSettings(), ...getStoredSettings() },
  }, { headers: { "Cache-Control": "no-store" } });
}
