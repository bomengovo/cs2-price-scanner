import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getServerSecret } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const envFile = path.join(process.cwd(), ".env.local");
type SecretName = "CSFLOAT_API_KEY" | "CSQAQ_API_TOKEN" | "STEAMDT_API_KEY";

/** Returns only whether each key is configured — never the secret value. */
export async function GET() {
  const configured = (name: SecretName) => Boolean(getServerSecret(name));
  return NextResponse.json({
    csfloatApiConfigured: configured("CSFLOAT_API_KEY"),
    csqaqApiConfigured: configured("CSQAQ_API_TOKEN"),
    steamdtApiConfigured: configured("STEAMDT_API_KEY"),
    csfloatProxy: getServerSecret("CSFLOAT_API_KEY") ? process.env.CSFLOAT_PROXY?.trim() ?? "" : "",
    usdCnyRate: process.env.USD_CNY_RATE?.trim() ?? "7.2",
  }, { headers: { "Cache-Control": "no-store" } });
}

/** Writes the provided secrets into .env.local so they take effect on the next scan/server restart. */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as {
      csfloatApiKey?: string;
      csqaqApiToken?: string;
      steamdtApiKey?: string;
      usdCnyRate?: number | string;
      csfloatProxy?: string;
    };
    const updates: Array<{ key: string; value: string }> = [];
    if (body.csfloatApiKey !== undefined) updates.push({ key: "CSFLOAT_API_KEY", value: body.csfloatApiKey });
    if (body.csqaqApiToken !== undefined) updates.push({ key: "CSQAQ_API_TOKEN", value: body.csqaqApiToken });
    if (body.steamdtApiKey !== undefined) updates.push({ key: "STEAMDT_API_KEY", value: body.steamdtApiKey });
    if (body.usdCnyRate !== undefined) updates.push({ key: "USD_CNY_RATE", value: String(body.usdCnyRate).trim() });
    if (body.csfloatProxy !== undefined) updates.push({ key: "CSFLOAT_PROXY", value: body.csfloatProxy });
    if (!updates.length) throw new Error("没有可保存的密钥");
    writeEnv(updates);
    return NextResponse.json(publicKeyStatus());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "密钥保存失败" }, { status: 400 });
  }
}

function publicKeyStatus() {
  const configured = (name: SecretName) => Boolean(getServerSecret(name));
  return { csfloatApiConfigured: configured("CSFLOAT_API_KEY"), csqaqApiConfigured: configured("CSQAQ_API_TOKEN"), steamdtApiConfigured: configured("STEAMDT_API_KEY") };
}

function writeEnv(updates: Array<{ key: string; value: string }>): void {
  let lines: string[] = [];
  if (fs.existsSync(envFile)) lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  const keySet = new Set(updates.map((u) => u.key));
  // Replace existing keys, keeping the rest of the file (comments, other vars) intact.
  const replaced = new Set<string>();
  const next = lines.map((line) => {
    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (!key || !keySet.has(key)) return line;
    replaced.add(key);
    const update = updates.find((u) => u.key === key)!;
    return `${update.key}=${update.value}`;
  });
  for (const update of updates) {
    if (!replaced.has(update.key)) next.push(`${update.key}=${update.value}`);
  }
  const content = next.filter((line, index, arr) => !(line === "" && arr[index - 1] === "" && index === arr.length - 1)).join("\n");
  fs.writeFileSync(envFile, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}
