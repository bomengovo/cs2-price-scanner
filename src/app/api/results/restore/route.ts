import { getDeletedResultCount, permanentlyDeleteResults, restoreDeletedResults } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ deletedCount: getDeletedResultCount() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { marketHashNames?: unknown };
  const names = Array.isArray(body.marketHashNames) ? body.marketHashNames.map(String) : undefined;
  return Response.json({ changed: restoreDeletedResults(names), deletedCount: getDeletedResultCount() });
}

export async function DELETE(request: Request) {
  const body = await request.json().catch(() => ({})) as { marketHashNames?: unknown };
  const names = Array.isArray(body.marketHashNames) ? body.marketHashNames.map(String) : undefined;
  return Response.json({ changed: permanentlyDeleteResults(names), deletedCount: getDeletedResultCount() });
}
