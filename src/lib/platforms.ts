import type { CanonicalPlatform } from "./types";
export { getBuffUrl, getYoupinUrl } from "./platform-links";

export function normalizePlatform(
  raw: string,
  aliases: Record<CanonicalPlatform, string[]>,
): CanonicalPlatform | null {
  const normalized = raw.trim().toLocaleLowerCase();
  for (const platform of ["buff", "youpin"] as const) {
    if (aliases[platform].some((alias) => normalized.includes(alias.toLocaleLowerCase()))) {
      return platform;
    }
  }
  return null;
}

