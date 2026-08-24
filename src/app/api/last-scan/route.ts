import { NextResponse } from "next/server";
import { environmentSettings } from "@/lib/config";
import { getLastScan, getStoredSettings } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ scan: getLastScan(), settings: { ...environmentSettings(), ...getStoredSettings() } }, { headers: { "Cache-Control": "no-store" } });
}

