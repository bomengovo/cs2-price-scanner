import { NextResponse } from "next/server";
import { turnoverStatus } from "@/lib/turnover-enrichment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(turnoverStatus(), { headers: { "Cache-Control": "no-store" } });
}

/**
 * 批量补全入口已停用：日成交量现在由扫描流程自动从 CSQAQ /info/chart 获取，
 * 不再通过本端点触发历史累计成交量的批量拉取。
 */
export async function POST() {
  return NextResponse.json({ status: "disabled", message: "批量补全已停用，日成交量随扫描自动填充" }, { status: 410 });
}
