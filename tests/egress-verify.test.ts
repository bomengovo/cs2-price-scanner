/**
 * Real CSFloat egress verification (opt-in, never runs during `npm test`).
 *
 * Run explicitly with:
 *   $env:RUN_CSFLOAT_EGRESS="1"; npx vitest run tests/egress-verify.test.ts
 *
 * Uses the exact production request path (undici + CSFLOAT_PROXY through
 * csfloat-network.ts and the global scheduler), with a scratch DB so the
 * running scanner's database is never touched.
 *
 * Tests:
 *   A. one real CSFloat request -> HTTP status, CF-Ray, Server, public IP
 *   B. two consecutive requests -> same public egress IP
 *   C. simulated ordinary 429 -> short cooldown, exactly one request, no retry
 *   D. simulated multi-IP 429 -> CSFLOAT_MULTI_IP_BLOCKED + long cooldown
 *   E. simulated IP change -> CSFLOAT_IP_CHANGED pause
 *
 * The 429/IP simulations use example.test URLs with stubbed responses, so the
 * only real CSFloat traffic is Test A's single limit=1 request.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getProviderState, getRateState, saveProviderState, saveRateState } from "../src/lib/db";
import { getCsfloatListingHeaders } from "../src/lib/env";
import { csfloatFetch, getCsfloatNetworkDiagnostics, isCsfloatMultiIp429, resetCsfloatNetworkDiagnosticsForTest } from "../src/lib/csfloat-network";
import { scheduleCsfloatListings } from "../src/lib/rate-limit/csfloat-scheduler";

const skip = process.env.RUN_CSFLOAT_EGRESS !== "1";

const dbPath = `D:/Codex/Temp/cs2-price-scanner-egress-${process.pid}.db`;
const PUBLIC_IP_URL = "https://api.ipify.org?format=json";

// csfloat-network.ts only uses the real undici + CSFLOAT_PROXY path when
// NODE_ENV is not "test", and vitest does not load .env.local.  Load the
// relevant variables and run the real-network checks in production mode so the
// verification exercises exactly the production request path (fixed proxy).
function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!["CSFLOAT_PROXY", "CSFLOAT_MULTI_IP_COOLDOWN_MS", "CSFLOAT_IP_CHECK_INTERVAL_MS", "CSFLOAT_PAUSE_ON_IP_CHANGE", "CSFLOAT_API_KEY", "CSFLOAT_LISTINGS_AUTH_REQUIRED"].includes(key)) continue;
    const value = match[2].split(/\s*#/)[0].trim();
    if (value) process.env[key] = value;
  }
}

async function publicIp(): Promise<string | null> {
  const response = await csfloatFetch(PUBLIC_IP_URL, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`IP 服务 HTTP ${response.status}`);
  const body = await response.json() as { ip?: unknown };
  return typeof body.ip === "string" && body.ip.trim() ? body.ip.trim() : null;
}

function listingsUrl(limit: number): string {
  const url = new URL("https://csfloat.com/api/v1/listings");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("type", "buy_now");
  url.searchParams.set("sort_by", "most_recent");
  return url.toString();
}

/** Same headers the scanner sends in production (Authorization: <API_KEY>). */
function productionHeaders(): HeadersInit {
  const useAuth = process.env.CSFLOAT_LISTINGS_AUTH_REQUIRED === "true";
  return getCsfloatListingHeaders(useAuth ? process.env.CSFLOAT_API_KEY : undefined);
}

function resetState(): void {
  saveRateState("csfloat", "listings", { lastRequestAt: 0, blockedUntil: 0 });
  saveProviderState("csfloat", { status: "CSFLOAT_LIVE", consecutiveFailures: 0, retryAt: null, message: null });
  resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.10", checkedAt: Date.now() });
}

beforeAll(async () => {
  fs.mkdirSync("D:/Codex/Temp", { recursive: true });
  loadEnvLocal();
  process.env.DB_PATH = dbPath;
  process.env.CSFLOAT_MIN_INTERVAL_MS = "0";
  // 保留 .env.local 中的真实认证开关（默认 true），让真实请求携带 API Key。
  process.env.CSFLOAT_MULTI_IP_COOLDOWN_MS = "1800000";
  process.env.CSFLOAT_PAUSE_ON_IP_CHANGE = "true";
  closeDb();
  resetState();
  // Real-network checks must use the production undici+proxy path.
  setNodeEnv("production");
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
});

describe.skipIf(skip)("CSFloat real egress verification", () => {
  it("A: one real CSFloat request records HTTP status, CF-Ray, Server and public IP", async () => {
    const ip1 = await publicIp();
    const diagnostics = getCsfloatNetworkDiagnostics();
    console.log("\nCSFloat Diagnostics");
    console.log("-------------------------");
    console.log(`Proxy Enabled: ${diagnostics.proxyEnabled}`);
    console.log(`Proxy Address: ${diagnostics.proxyAddress ?? "DIRECT"}`);
    console.log(`Public IP: ${ip1 ?? "unavailable"}`);
    expect(ip1).toBeTruthy();

    const startedAt = Date.now();
    const response = await scheduleCsfloatListings({ url: listingsUrl(1), headers: productionHeaders(), sessionId: "egress-a", page: 1, caller: "egress-verify-a" });
    const durationMs = Date.now() - startedAt;
    const cfRay = response.headers.get("cf-ray");
    const server = response.headers.get("server");
    console.log(`HTTP Status: ${response.status}`);
    console.log(`CF-Ray: ${cfRay ?? ""}`);
    console.log(`Server: ${server ?? ""}`);
    console.log(`Duration ms: ${durationMs}`);
    expect(response.ok).toBe(true);

    const body = await response.json() as unknown;
    const count = Array.isArray(body) ? body.length : Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data.length : 0;
    console.log(`Listings returned: ${count}`);
    expect(count).toBeGreaterThan(0);
  }, 30_000);

  it("B: consecutive requests keep the same public egress IP", async () => {
    resetState();
    const ip1 = await publicIp();
    const response = await scheduleCsfloatListings({ url: listingsUrl(1), headers: productionHeaders(), sessionId: "egress-b1", page: 1, caller: "egress-b1" });
    expect(response.ok).toBe(true);
    const ip2 = await publicIp();
    console.log(`Public IP (1st): ${ip1 ?? "unavailable"}`);
    console.log(`Public IP (2nd): ${ip2 ?? "unavailable"}`);
    expect(ip1).toBe(ip2);
  }, 30_000);

  // The 429/IP-change simulations below must run in test mode: only then does
  // csfloat-network route through global fetch, so the stubbed responses are
  // observed.  They never touch the real CSFloat endpoint.
  it("C: simulated ordinary 429 enters a short cooldown and makes exactly one request", async () => {
    const previous = setNodeEnv("test");
    try {
      resetState();
      const original = globalThis.fetch;
      globalThis.fetch = viFetch(new Response("{}", { status: 429, headers: { "retry-after": "2" } }));
      try {
        await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "egress-c", page: 1, caller: "egress-c" }))
          .rejects.toMatchObject({ errorCode: "CSFLOAT_RATE_LIMIT", httpStatus: 429 });
        await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "egress-c2", page: 1, caller: "egress-c2" }))
          .rejects.toMatchObject({ errorCode: "LOCAL_COOLDOWN" });
      } finally {
        globalThis.fetch = original;
      }
      const state = getRateState("csfloat", "listings");
      expect(state.blockedUntil).toBeGreaterThan(Date.now());
      expect(getProviderState("csfloat").status).toBe("CSFLOAT_RATE_LIMITED");
      console.log(`Cooldown remaining seconds: ${Math.ceil((state.blockedUntil - Date.now()) / 1000)}`);
    } finally {
      setNodeEnv(previous);
    }
  });

  it("D: simulated multi-IP 429 enters CSFLOAT_MULTI_IP_BLOCKED with a long cooldown", async () => {
    const previous = setNodeEnv("test");
    try {
      resetState();
      const original = globalThis.fetch;
      globalThis.fetch = viFetch(new Response("You've been making too many requests from too many IPs", { status: 429 }));
      try {
        await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "egress-d", page: 1, caller: "egress-d" }))
          .rejects.toMatchObject({ errorCode: "CSFLOAT_MULTI_IP_BLOCKED" });
      } finally {
        globalThis.fetch = original;
      }
      expect(getProviderState("csfloat").status).toBe("CSFLOAT_MULTI_IP_BLOCKED");
      expect(getRateState("csfloat", "listings").blockedUntil).toBeGreaterThanOrEqual(Date.now() + 1_700_000);
      expect(isCsfloatMultiIp429("You've been making too many requests from too many IPs")).toBe(true);
      const minutes = Math.round((getRateState("csfloat", "listings").blockedUntil - Date.now()) / 60000);
      console.log(`Cooldown minutes: ${minutes}`);
    } finally {
      setNodeEnv(previous);
    }
  });

  it("E: simulated IP change pauses CSFloat before any network request", async () => {
    const previous = setNodeEnv("test");
    try {
      resetState();
      resetCsfloatNetworkDiagnosticsForTest({ startupPublicIp: "203.0.113.10", currentPublicIp: "203.0.113.77", checkedAt: Date.now(), ipChanged: true });
      const fetchMock = { calls: 0 };
      const original = globalThis.fetch;
      globalThis.fetch = async () => { fetchMock.calls += 1; return new Response("{}", { status: 200 }); };
      try {
        await expect(scheduleCsfloatListings({ url: "https://example.test/listings", headers: {}, sessionId: "egress-e", page: 1, caller: "egress-e" }))
          .rejects.toMatchObject({ errorCode: "CSFLOAT_IP_CHANGED" });
      } finally {
        globalThis.fetch = original;
      }
      expect(getProviderState("csfloat").status).toBe("CSFLOAT_IP_CHANGED");
      expect(fetchMock.calls).toBe(0);
    } finally {
      setNodeEnv(previous);
    }
  });
});

function viFetch(response: Response): typeof globalThis.fetch {
  return async () => response;
}

function setNodeEnv(value: string): string {
  const previous = process.env.NODE_ENV;
  // Next's ProcessEnv types NODE_ENV as read-only; the test process may switch
  // between production (real undici+proxy) and test (stubbed global fetch).
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
  return previous ?? "";
}
