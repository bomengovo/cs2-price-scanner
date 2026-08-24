const baseUrl = (process.env.SCANNER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

console.log("=== Provider Diagnosis ===");
console.log(`scanner: ${baseUrl}`);
console.log("CSFloat is never requested directly by this script; it reads the running scanner diagnostics so the global limiter and fixed egress are preserved.");

try {
  const response = await fetch(`${baseUrl}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  const health = await response.json();
  if (!response.ok || health.status !== "ok") throw new Error(health.message ?? `HTTP ${response.status}`);
  const csfloat = health.providers?.csfloat ?? {};
  const diagnostics = csfloat.diagnostics ?? {};
  console.log("\nCSFloat");
  console.log(`State: ${csfloat.status ?? "UNKNOWN"}`);
  console.log(`Proxy enabled: ${Boolean(diagnostics.proxyEnabled)}`);
  console.log(`Proxy address: ${diagnostics.proxyAddress ?? "DIRECT"}`);
  console.log(`Startup public IP: ${diagnostics.startupPublicIp ?? "unavailable"}`);
  console.log(`Current public IP: ${diagnostics.currentPublicIp ?? "unavailable"}`);
  console.log(`IP changed: ${Boolean(diagnostics.ipChanged)}`);
  console.log(`Last HTTP: ${diagnostics.lastHttpStatus ?? "none"}`);
  console.log(`CF-Ray: ${diagnostics.lastCfRay ?? ""}`);
  console.log(`Server: ${diagnostics.lastServer ?? ""}`);
  console.log(`Retry-After ms: ${diagnostics.lastRetryAfterMs ?? ""}`);
  console.log(`Error type: ${diagnostics.lastErrorType ?? ""}`);
  console.log(`Last error at: ${diagnostics.lastErrorAt ? new Date(diagnostics.lastErrorAt).toISOString() : ""}`);
  console.log(`Cooldown seconds: ${Math.ceil(Number(csfloat.remainingMs ?? 0) / 1000)}`);
  console.log("\nCSQAQ");
  console.log(`State: ${health.providers?.csqaq?.status ?? "UNKNOWN"}`);
} catch (error) {
  console.error(`诊断失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
