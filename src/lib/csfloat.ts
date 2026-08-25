import { ApiError } from "./http";
import { buildItemImageCandidates } from "./items";
import type { CSFloatListing } from "./types";
import { getCsfloatUrl } from "./platform-links";
import { getCsfloatListingHeaders, getServerSecret } from "./env";
import { csfloatNeedsProbe, scheduleCsfloatListings } from "./rate-limit/csfloat-scheduler";
import fs from "node:fs";
import path from "node:path";

type RawListing = Record<string, unknown> & { item?: Record<string, unknown> };/**
 * Fetches the REAL-TIME lowest buy-now (in-stock sell) price for a single item
 * by its market_hash_name. CSFloat's public API does not expose buy orders, so
 * this returns the lowest in-stock sell price ("Buy Now"), in USD cents.
 *
 * Goes through the global CSFloat scheduler + fixed proxy. Returns null when the
 * item has no live buy-now listings or the request fails.
 */
export async function getCSFloatLowestSellPrice(options: {
  marketHashName: string;
  apiKey?: string;
  signal?: AbortSignal;
  sessionId?: string;
}): Promise<{ priceUsdCents: number; listingId: string } | null> {
  const key = options.apiKey?.trim() || getServerSecret("CSFLOAT_API_KEY");
  const useAuth = process.env.CSFLOAT_LISTINGS_AUTH_REQUIRED === "true";
  const url = new URL("https://csfloat.com/api/v1/listings");
  url.searchParams.set("limit", "50");
  url.searchParams.set("type", "buy_now");
  url.searchParams.set("market_hash_name", options.marketHashName);
  let response: Response;
  if (csfloatNeedsProbe()) {
    // A short probe first: when a prior 429 ended but recovery was unverified,
    // send one minimal request before the real query.
    const probeUrl = new URL("https://csfloat.com/api/v1/listings");
    probeUrl.searchParams.set("limit", "1");
    probeUrl.searchParams.set("type", "buy_now");
    const probe = await scheduleCsfloatListings({ url: probeUrl.toString(), headers: getCsfloatListingHeaders(useAuth ? key : undefined), signal: options.signal, sessionId: options.sessionId ?? "untracked", page: 0, caller: "csfloat-live-probe", probe: true });
    if (!probe.ok) throw new ApiError("CSFloat 恢复验证失败", probe.status);
    await probe.body?.cancel().catch(() => undefined);
  }
  response = await scheduleCsfloatListings({ url: url.toString(), headers: getCsfloatListingHeaders(useAuth ? key : undefined), signal: options.signal, sessionId: options.sessionId ?? "untracked", page: 1, caller: "getCSFloatLowestSellPrice" });
  const body = await response.json() as unknown;
  const rawList = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown }).data) ? (body as { data: RawListing[] }).data : [];
  let best: { price: number; id: string } | null = null;
  for (const raw of rawList as RawListing[]) {
    const price = Number(raw.price);
    const id = String(raw.id ?? "");
    if (!Number.isFinite(price) || price <= 0 || !id) continue;
    if (!best || price < best.price) best = { price, id };
  }
  if (!best) return null;
  return { priceUsdCents: best.price, listingId: best.id };
}

export function normalizeCSFloatListing(raw: RawListing): CSFloatListing | null {
  const item = raw.item ?? {};
  const marketHashName = String(item.market_hash_name ?? item.marketHashName ?? raw.market_hash_name ?? raw.marketHashName ?? "").trim();
  const id = String(raw.id ?? "").trim();
  const price = Number(raw.price);
  if (!marketHashName || !id || !Number.isFinite(price)) return null;
  const imageUrls = buildItemImageCandidates(
    typeof item.icon_url === "string" ? item.icon_url : null,
    typeof item.image_url === "string" ? item.image_url : null,
    typeof item.image === "string" ? item.image : null,
  );
  return {
    id,
    price,
    createdAt: String(raw.created_at ?? new Date().toISOString()),
    marketHashName,
    itemName: String(item.item_name ?? item.itemName ?? marketHashName.replace(/ \([^)]*\)$/, "")),
    wearName: String(item.wear_name ?? extractWear(marketHashName)),
    floatValue: nullableNumber(item.float_value ?? item.floatValue),
    defIndex: nullableNumber(item.def_index),
    paintIndex: nullableNumber(item.paint_index),
    paintSeed: nullableNumber(item.paint_seed),
    isStatTrak: Boolean(item.is_stattrak) || marketHashName.startsWith("StatTrak™"),
    isSouvenir: Boolean(item.is_souvenir) || marketHashName.startsWith("Souvenir"),
    iconUrl: imageUrls[0] ?? "",
    imageUrls,
    inspectLink: String(item.inspect_link ?? ""),
    listingUrl: getCsfloatUrl(id, marketHashName)!,
  };
}

export async function fetchCSFloatListings(options: {
  limit: number | "all";
  maxSafePages: number;
  apiKey?: string;
  signal?: AbortSignal;
  onPage?: (listings: CSFloatListing[], page: number) => void;
  sessionId?: string;
}): Promise<CSFloatListing[]> {
  const listings: CSFloatListing[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  const useAuth = process.env.CSFLOAT_LISTINGS_AUTH_REQUIRED === "true";
  const key = options.apiKey?.trim() || getServerSecret("CSFLOAT_API_KEY");
  // PROBE: when a previous 429/multi-IP/IP-change cooldown has ended but recovery
  // was not verified yet, send exactly one minimal request first.  Only after it
  // succeeds does the real pagination start.  A failed probe throws through the
  // same scheduler, which re-enters the cooldown and never retries in a loop.
  if (csfloatNeedsProbe()) {
    const probeUrl = new URL("https://csfloat.com/api/v1/listings");
    probeUrl.searchParams.set("limit", "1");
    probeUrl.searchParams.set("type", "buy_now");
    probeUrl.searchParams.set("sort_by", "most_recent");
    const probeResponse = await scheduleCsfloatListings({ url: probeUrl.toString(), headers: getCsfloatListingHeaders(useAuth ? key : undefined), signal: options.signal, sessionId: options.sessionId ?? "untracked", page: 0, caller: "csfloat-probe", probe: true });
    if (!probeResponse.ok) throw new ApiError("CSFloat 恢复验证失败", probeResponse.status);
    await probeResponse.body?.cancel().catch(() => undefined);
  }
  for (let page = 1; page <= options.maxSafePages; page += 1) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const remaining = options.limit === "all" ? 50 : Math.min(50, Math.max(0, options.limit - listings.length));
    if (remaining === 0) break;
    const url = new URL("https://csfloat.com/api/v1/listings");
    url.searchParams.set("limit", String(remaining));
    url.searchParams.set("type", "buy_now");
    url.searchParams.set("sort_by", "most_recent");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await scheduleCsfloatListings({ url: url.toString(), headers: getCsfloatListingHeaders(useAuth ? key : undefined), signal: options.signal, sessionId: options.sessionId ?? "untracked", page, caller: "fetchCSFloatListings" });
    const body = await response.json() as unknown;
    const rawList = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown }).data) ? (body as { data: RawListing[] }).data : [];
    const pageListings = (rawList as RawListing[]).map(normalizeCSFloatListing).filter((item): item is CSFloatListing => Boolean(item));
    if (pageListings.length !== rawList.length) logNormalizationSummary(page, rawList.length, pageListings.length);
    listings.push(...pageListings);
    options.onPage?.(pageListings, page);
    if (rawList.length < remaining) break;
    const nextCursor = extractNextCursor(response, body);
    if (!nextCursor) { if (rawList.length === remaining) logCursorMissing(page); break; }
    if (seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  if (!listings.length) throw new ApiError("CSFloat 没有返回可用的在售饰品");
  return options.limit === "all" ? listings : listings.slice(0, options.limit);
}

export function extractNextCursor(response: Response, body: unknown): string | null {
  const object = !Array.isArray(body) && body && typeof body === "object" ? body as { cursor?: unknown; next_cursor?: unknown; nextCursor?: unknown } : null;
  const candidates = [response.headers.get("x-next-cursor"), response.headers.get("x-cursor"), object?.next_cursor, object?.nextCursor, object?.cursor];
  for (const value of candidates) { if (typeof value === "string" && value.trim()) return value.trim(); }
  return null;
}

function logCursorMissing(page: number): void {
  try { const directory = path.join(process.cwd(), "logs"); fs.mkdirSync(directory, { recursive: true }); fs.appendFileSync(path.join(directory, "provider-api.log"), `${new Date().toISOString()} provider=csfloat code=CSFLOAT_CURSOR_MISSING page=${page}\n`, "utf8"); } catch { /* diagnostics only */ }
}

function logNormalizationSummary(page: number, raw: number, valid: number): void {
  try { const directory = path.join(process.cwd(), "logs"); fs.mkdirSync(directory, { recursive: true }); fs.appendFileSync(path.join(directory, "provider-api.log"), `${new Date().toISOString()} provider=csfloat code=CSFLOAT_NORMALIZE_SKIPPED page=${page} raw=${raw} valid=${valid}\n`, "utf8"); } catch { /* diagnostics only */ }
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : number;
}

function extractWear(name: string): string {
  return name.match(/\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/)?.[1] ?? "—";
}
