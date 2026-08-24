import { softDeleteResults } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: { params: Promise<{ marketHashName: string }> }) {
  const { marketHashName } = await context.params;
  const changed = softDeleteResults([decodeURIComponent(marketHashName)]);
  return Response.json({ changed });
}
