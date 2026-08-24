import { softDeleteResults } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { marketHashNames?: unknown } | null;
  if (!Array.isArray(body?.marketHashNames)) return Response.json({ error: "删除参数无效" }, { status: 400 });
  const changed = softDeleteResults(body.marketHashNames.map(String));
  return Response.json({ changed });
}
