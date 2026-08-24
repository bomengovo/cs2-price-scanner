import { NextResponse } from "next/server";
import { environmentSettings } from "@/lib/config";
import { getStoredSettings, saveSettings } from "@/lib/db";
import type { AppSettings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicSettings(): AppSettings {
  return { ...environmentSettings(), ...getStoredSettings() } as AppSettings;
}

export async function GET() {
  return NextResponse.json(publicSettings(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as Partial<AppSettings>;
    validateSettings(body);
    saveSettings(body);
    return NextResponse.json(publicSettings());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "设置保存失败" }, { status: 400 });
  }
}

function validateSettings(value: Partial<AppSettings>): void {
  const positive: Array<keyof AppSettings> = ["usdCnyRate", "priceCacheMinutes", "volumeCacheSeconds", "maxScanCount", "maxSafePages"];
  for (const key of positive) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || Number(value[key]) <= 0)) throw new Error(`${key} 必须大于 0`);
  }
  for (const key of ["minDiff", "minDiffPercent"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || value[key] < 0)) throw new Error(`${key} 不能小于 0`);
  }
  if (value.platformAliases && (!Array.isArray(value.platformAliases.buff) || !Array.isArray(value.platformAliases.youpin))) throw new Error("平台 Alias 格式错误");
}
