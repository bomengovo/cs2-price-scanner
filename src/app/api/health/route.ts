import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import fs from "node:fs";
import path from "node:path";
import { csfloatStatus } from "@/lib/rate-limit/csfloat-scheduler";
import { csqaqStatus } from "@/lib/rate-limit/csqaq-scheduler";
import { getCsqaqAuthState, startCsqaqBindPreflight } from "@/lib/csqaq-ip-binding";
import { turnoverStatus } from "@/lib/turnover-enrichment";
import { startCsfloatNetworkMonitor } from "@/lib/csfloat-network";

const processStartedAt = process.env.SCANNER_STARTED_AT || new Date(Date.now() - process.uptime() * 1000).toISOString();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    startCsqaqBindPreflight();
    startCsfloatNetworkMonitor();
    const database = getDb();
    database.prepare("SELECT 1 AS ok").get();
    const savedResults = (database.prepare("SELECT COUNT(*) AS count FROM scan_results WHERE is_deleted = 0 AND source = 'live'").get() as { count: number }).count;
    const schemaRow = database.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get() as { value?: string } | undefined;
    return NextResponse.json(
      {
        status: "ok",
        app: "cs2-price-scanner",
        database: "ok",
        pid: process.pid,
        instanceId: process.env.SCANNER_INSTANCE_ID || "manual",
        buildId: readBuildId(),
        startedAt: processStartedAt,
        appVersion: process.env.npm_package_version || "0.1.0",
        schemaVersion: schemaRow?.value ? JSON.parse(schemaRow.value) : null,
        savedResults,
        providers: {
          csfloat: csfloatStatus(),
          csqaq: { ...getCsqaqAuthState(), scheduler: csqaqStatus() },
          turnover: turnoverStatus(),
        },
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        app: "cs2-price-scanner",
        database: "error",
        message: error instanceof Error ? error.message : "Database check failed",
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function readBuildId(): string {
  try { return fs.readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim(); }
  catch { return "development"; }
}
