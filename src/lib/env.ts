import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const envFile = path.join(projectRoot, ".env.local");

type SecretName = "STEAMDT_API_KEY" | "CSFLOAT_API_KEY" | "CSQAQ_API_TOKEN";

export function getServerSecret(name: SecretName): string | undefined {
  const loaded = process.env[name]?.trim();
  if (loaded) return loaded;
  if (!fs.existsSync(envFile)) return undefined;
  // Recover a value from a legacy file whose comment/newline encoding was
  // damaged. The value never leaves the server and is never logged.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fs.readFileSync(envFile, "utf8").match(new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}\\s*=\\s*([^\\s\u0060#]+)`, "m"));
  const value = match?.[1]?.trim();
  return value && !/^(?:\*+|your[_-]?key|changeme)$/i.test(value) ? value : undefined;
}

function configured(name: SecretName): boolean {
  return Boolean(getServerSecret(name));
}

export function environmentDiagnostics() {
  return {
    cwd: projectRoot,
    cwdCorrect: path.basename(projectRoot).toLowerCase() === "cs2-price-scanner",
    envFileDetected: fs.existsSync(envFile),
    steamdtKeyConfigured: configured("STEAMDT_API_KEY"),
    csfloatKeyConfigured: configured("CSFLOAT_API_KEY"),
    csqaqTokenConfigured: configured("CSQAQ_API_TOKEN"),
    mockMode: process.env.MOCK_MODE === "true" && process.env.NODE_ENV === "test",
  };
}

export function getCsqaqHeaders(explicitToken?: string): HeadersInit {
  const token = explicitToken?.trim() || getServerSecret("CSQAQ_API_TOKEN");
  if (!token) throw new Error("未配置 CSQAQ_API_TOKEN");
  return { ApiToken: token, Accept: "application/json", "Content-Type": "application/json" };
}

export function getSteamDtHeaders(explicitKey?: string): HeadersInit {
  const key = explicitKey?.trim() || getServerSecret("STEAMDT_API_KEY");
  if (!key) throw new Error("SteamDT API Key读取失败，请检查服务器环境变量。");
  return { Authorization: `Bearer ${key}`, Accept: "application/json" };
}

export function getCsfloatHeaders(explicitKey?: string): HeadersInit {
  const key = explicitKey?.trim() || getServerSecret("CSFLOAT_API_KEY");
  if (!key) throw new Error("CSFloat API Key读取失败，请检查服务器环境变量。");
  return getCsfloatListingHeaders(key);
}

export function getCsfloatListingHeaders(explicitKey?: string): HeadersInit {
  const key = explicitKey?.trim();
  return {
    ...(key ? { Authorization: key } : {}),
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    // Keep the server-side request identity stable and explicit. In particular,
    // all live calls must use the same Node/Next egress path; mixing this path
    // with proxy-routed curl requests can trigger CSFloat's multi-IP protection.
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  };
}
