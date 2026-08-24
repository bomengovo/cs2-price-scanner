import type { ItemCategory } from "./types";

const categoryPrefixes: Array<[ItemCategory, string[]]> = [
  ["sniper", ["AWP", "SSG 08", "SCAR-20", "G3SG1"]],
  ["rifle", ["AK-47", "M4A1-S", "M4A4", "AUG", "FAMAS", "Galil AR", "SG 553"]],
  ["pistol", ["Glock-18", "USP-S", "P2000", "P250", "Five-SeveN", "Tec-9", "CZ75-Auto", "Desert Eagle", "R8 Revolver", "Dual Berettas"]],
  ["smg", ["MAC-10", "MP9", "MP7", "MP5-SD", "UMP-45", "P90", "PP-Bizon"]],
  ["shotgun", ["Nova", "XM1014", "MAG-7", "Sawed-Off"]],
  ["machinegun", ["M249", "Negev"]],
];

export function categorizeItem(marketHashName: string): ItemCategory {
  if (/Gloves|Hand Wraps/i.test(marketHashName)) return "gloves";
  if (/★|Knife|Bayonet|Karambit|Daggers|Falchion|Kukri/i.test(marketHashName)) return "knife";
  const plain = marketHashName.replace(/^StatTrak™\s+|^Souvenir\s+/i, "");
  return categoryPrefixes.find(([, names]) => names.some((name) => plain.startsWith(name)))?.[0] ?? "other";
}

export function normalizeCsfloatImageUrl(iconUrl: string | null | undefined): string {
  const value = iconUrl?.trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value.replace(/^http:\/\//i, "https://");
  const cleaned = value
    .replace(/^\/+/, "")
    .replace(/^economy\/image\//i, "")
    .replace(/\/\d+fx\d+f$/i, "");
  return `https://community.cloudflare.steamstatic.com/economy/image/${cleaned}/360fx360f`;
}

export function buildItemImageCandidates(...values: Array<string | null | undefined>): string[] {
  const candidates: string[] = [];
  for (const value of values) {
    const normalized = normalizeCsfloatImageUrl(value);
    if (!normalized) continue;
    candidates.push(normalized);
    if (normalized.includes("community.cloudflare.steamstatic.com")) candidates.push(normalized.replace("community.cloudflare.steamstatic.com", "community.akamai.steamstatic.com"));
    if (normalized.includes("community.akamai.steamstatic.com")) candidates.push(normalized.replace("community.akamai.steamstatic.com", "community.cloudflare.steamstatic.com"));
  }
  return [...new Set(candidates)];
}

export function resolveItemImage(imageUrl: string | null | undefined, loadFailed: boolean): string | null {
  return loadFailed ? null : normalizeCsfloatImageUrl(imageUrl) || null;
}

export function lowestListings<T extends { marketHashName: string; price: number }>(items: T[]): T[] {
  const lowest = new Map<string, T>();
  for (const item of items) {
    const current = lowest.get(item.marketHashName);
    if (!current || item.price < current.price) lowest.set(item.marketHashName, item);
  }
  return [...lowest.values()];
}
