import type { ScanResult } from "./types";

const INVALID_ID_VALUES = new Set(["", "undefined", "null", "nan"]);

function normalizeNumericId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const id = String(value).trim();
  if (INVALID_ID_VALUES.has(id.toLocaleLowerCase()) || !/^[1-9]\d*$/.test(id)) return null;
  return id;
}

export function isValidBuffGoodsId(value: unknown, marketHashName?: string): boolean {
  const id = normalizeNumericId(value);
  return Boolean(id && id !== marketHashName?.trim());
}

export function isValidYoupinTemplateId(value: unknown, marketHashName?: string): boolean {
  const id = normalizeNumericId(value);
  return Boolean(id && id !== marketHashName?.trim());
}

export function getCsfloatListingUrl(listingId: unknown): string | null {
  const id = normalizeNumericId(listingId);
  return id ? `https://csfloat.com/item/${id}` : null;
}

export function getCsfloatMarketUrl(marketHashName: unknown): string | null {
  if (typeof marketHashName !== "string" || !marketHashName.trim()) return null;
  return `https://csfloat.com/search?market_hash_name=${encodeURIComponent(marketHashName.trim())}`;
}

export function getCsfloatUrl(listingId: unknown, marketHashName: unknown): string | null {
  return getCsfloatListingUrl(listingId) ?? getCsfloatMarketUrl(marketHashName);
}

export function getBuffUrl(goodsId: unknown, marketHashName?: string): string | null {
  if (!isValidBuffGoodsId(goodsId, marketHashName)) return null;
  return `https://buff.163.com/goods/${String(goodsId).trim()}`;
}

export function getYoupinUrl(templateId: unknown, marketHashName?: string): string | null {
  if (!isValidYoupinTemplateId(templateId, marketHashName)) return null;
  const url = new URL("https://youpin898.com/market/goods-list");
  url.searchParams.set("gameId", "730");
  url.searchParams.set("listType", "10");
  url.searchParams.set("templateId", String(templateId).trim());
  return url.toString();
}

export interface PlatformLinkValidation {
  marketHashName: string;
  valid: boolean;
  errors: string[];
  urls: { csfloat: string | null; buff: string | null; youpin: string | null };
}

export function validatePlatformLinks(results: ScanResult[], sampleSize = 10): PlatformLinkValidation[] {
  const distinct = [...new Map(results.map((result) => [result.marketHashName, result])).values()].slice(0, sampleSize);
  return distinct.map((result) => {
    const urls = {
      csfloat: getCsfloatUrl(result.csfloatListingId, result.marketHashName),
      buff: getBuffUrl(result.buffGoodsId, result.marketHashName),
      youpin: getYoupinUrl(result.youpinTemplateId, result.marketHashName),
    };
    const errors: string[] = [];
    for (const [platform, url] of Object.entries(urls)) {
      if (!url) continue;
      try { new URL(url); } catch { errors.push(`${platform} URL 格式无效`); }
      if (/undefined|null|nan/i.test(url)) errors.push(`${platform} URL 包含无效值`);
    }
    if (urls.buff && new URL(urls.buff).pathname.split("/").at(-1) !== result.buffGoodsId) errors.push("BUFF goodsId 不一致");
    if (urls.youpin && new URL(urls.youpin).searchParams.get("templateId") !== result.youpinTemplateId) errors.push("UU templateId 不一致");
    if (getCsfloatListingUrl(result.csfloatListingId) && urls.csfloat !== `https://csfloat.com/item/${result.csfloatListingId}`) errors.push("CSFloat listingId 不一致");
    return { marketHashName: result.marketHashName, valid: errors.length === 0, errors, urls };
  });
}

