import type { AppSettings } from "./types";
import fs from "node:fs";
import path from "node:path";
import { getServerSecret } from "./env";

const fallbackAliases = {
  buff: ["buff", "buff163", "网易buff"],
  youpin: ["uu", "youpin", "悠悠", "有品", "悠悠有品", "uu有品"],
};

export const defaultAliases = readAliasConfig();

export function environmentSettings(): AppSettings {
  const rate = Number(process.env.USD_CNY_RATE ?? "7.2");
  return {
    usdCnyRate: Number.isFinite(rate) && rate > 0 ? rate : 7.2,
    priceCacheMinutes: 1,
    volumeCacheSeconds: 300,
    maxScanCount: 5000,
    maxSafePages: 200,
    minDiff: 0,
    minDiffPercent: 0,
    platformAliases: defaultAliases,
    steamdtApiConfigured: Boolean(getServerSecret("STEAMDT_API_KEY")),
    csfloatApiConfigured: Boolean(getServerSecret("CSFLOAT_API_KEY")),
    csqaqApiConfigured: Boolean(getServerSecret("CSQAQ_API_TOKEN")),
    domesticProvider: process.env.DOMESTIC_PROVIDER === "steamdt" || process.env.DOMESTIC_PROVIDER === "auto" ? process.env.DOMESTIC_PROVIDER : "csqaq",
    // Demo data must never be selected merely because credentials are absent.
    // It is intentionally opt-in and is additionally allowed for test runs.
    mockMode: process.env.MOCK_MODE === "true" && process.env.NODE_ENV === "test",
  };
}

function readAliasConfig(): typeof fallbackAliases {
  try {
    const file = path.join(process.cwd(), "config", "platform-aliases.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed.buff) && Array.isArray(parsed.youpin)) return parsed;
  } catch { /* 首次启动或配置损坏时使用安全默认值 */ }
  return fallbackAliases;
}
