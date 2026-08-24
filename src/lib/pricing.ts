import type { CanonicalPlatform, PlatformPrice, ScanResult } from "./types";

export function centsToUsd(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) throw new Error("CSFloat 价格格式异常");
  return cents / 100;
}

export function usdToCny(usd: number, rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("美元人民币汇率异常");
  return roundMoney(usd * rate);
}

/**
 * SteamDT 官方响应把 sellPrice 定义为浮点价格。本函数保持独立，真实数据
 * 首次接入时会检查数量级；若 API 后续改为分单位，只需在这里调整。
 */
export function normalizeSteamDTPrice(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) {
    throw new Error("SteamDT 返回了无效价格");
  }
  if (numeric > 10_000_000) {
    throw new Error("SteamDT 价格数量级异常，请检查 API 单位");
  }
  return roundMoney(numeric);
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateComparison(
  base: Omit<ScanResult, "buffDiff" | "buffDiffPercent" | "youpinDiff" | "youpinDiffPercent" | "bestSellPrice" | "bestPlatform" | "bestDiff" | "bestDiffPercent" | "isDoubleLow">,
): ScanResult {
  const diff = (price: PlatformPrice | null) =>
    price ? roundMoney(price.sellPrice - base.csfloatCny) : null;
  const percent = (value: number | null) =>
    value === null || base.csfloatCny <= 0 ? null : roundMoney((value / base.csfloatCny) * 100);
  const buffDiff = diff(base.buff);
  const youpinDiff = diff(base.youpin);
  const candidates: Array<{ platform: CanonicalPlatform; price: number; difference: number }> = [];
  if (base.buff && base.buff.status !== "stale" && buffDiff !== null) candidates.push({ platform: "buff", price: base.buff.sellPrice, difference: buffDiff });
  if (base.youpin && base.youpin.status !== "stale" && youpinDiff !== null) candidates.push({ platform: "youpin", price: base.youpin.sellPrice, difference: youpinDiff });
  const best = candidates.sort((a, b) => b.price - a.price)[0] ?? null;
  return {
    ...base,
    buffDiff,
    buffDiffPercent: percent(buffDiff),
    youpinDiff,
    youpinDiffPercent: percent(youpinDiff),
    bestSellPrice: best?.price ?? null,
    bestPlatform: best?.platform ?? null,
    bestDiff: best?.difference ?? null,
    bestDiffPercent: percent(best?.difference ?? null),
    isDoubleLow: Boolean(buffDiff !== null && buffDiff > 0 && youpinDiff !== null && youpinDiff > 0),
  };
}
