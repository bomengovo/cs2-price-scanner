import { NextResponse } from "next/server";
import { steamDTBatchStatus } from "@/lib/rate-limit/steamdt-scheduler";
import { csfloatStatus } from "@/lib/rate-limit/csfloat-scheduler";
import { csqaqStatus } from "@/lib/rate-limit/csqaq-scheduler";
import { getCsqaqAuthState } from "@/lib/csqaq-ip-binding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const batch = steamDTBatchStatus();
  const csfloat = csfloatStatus();
  const csqaq = csqaqStatus();
  return NextResponse.json({
    csfloat: { ...csfloat, retryAfter: Math.ceil(csfloat.remainingMs / 1000) },
    csqaq: { ...csqaq, auth: getCsqaqAuthState(), retryAfter: Math.ceil(csqaq.remainingMs / 1000) },
    steamdtBatch: { blocked: batch.blocked, retryAfter: Math.ceil(batch.remainingMs / 1000), lastRequestAt: batch.lastRequestAt },
    steamdtSingle: { blocked: false, retryAfter: 0 }, now: Date.now(),
  }, { headers: { "Cache-Control": "no-store" } });
}
