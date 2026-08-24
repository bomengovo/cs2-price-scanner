import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const targetUrl = process.argv[2] || "http://127.0.0.1:3000";
let browserStderr = "";
const browserCandidates = [
  path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
];
const browserExe = browserCandidates.find((candidate) => candidate && fs.existsSync(candidate));
if (!browserExe) { console.error(JSON.stringify({ status: "FAIL", error: "未找到 Edge 或 Chrome" })); process.exit(1); }

const debugPort = 39100 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cs2-scanner-smoke-"));
const browser = spawn(browserExe, [`--headless=new`, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", "--disable-background-networking", "about:blank"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
browser.stderr.on("data", (chunk) => { browserStderr += String(chunk); });

try {
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, 10_000);
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json());
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await Promise.all([cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("Page.enable"), cdp.send("Log.enable")]);
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  cdp.on("Runtime.consoleAPICalled", (event) => { if (event.type === "error") consoleErrors.push(event.args.map((item) => item.value ?? item.description ?? "error").join(" ")); });
  cdp.on("Runtime.exceptionThrown", (event) => pageErrors.push(event.exceptionDetails?.text || event.exceptionDetails?.exception?.description || "page error"));
  cdp.on("Log.entryAdded", (event) => { if (event.entry?.level === "error" && !String(event.entry?.source).includes("network")) consoleErrors.push(event.entry.text); });
  cdp.on("Network.loadingFailed", (event) => { if (["Document", "Script", "Stylesheet", "XHR", "Fetch"].includes(event.type) && !event.canceled) requestFailures.push(`${event.type}: ${event.errorText}`); });
  const loaded = cdp.once("Page.loadEventFired", 15_000);
  await cdp.send("Page.navigate", { url: targetUrl });
  await loaded;
  await delay(3_000);
  const evaluation = await cdp.send("Runtime.evaluate", { expression: `(() => ({ title: document.title, text: document.body?.innerText || "", rows: document.querySelectorAll("tbody tr").length, scripts: [...document.scripts].filter(s => s.src.includes("/_next/static/")).length, styles: [...document.styleSheets].filter(s => String(s.href).includes("/_next/static/")).length, brokenImages: [...document.images].filter(img => img.complete && img.naturalWidth === 0).length }))()`, returnByValue: true });
  const page = evaluation.result?.value || {};
  const rendered = String(page.text).includes("CS2 跨平台价差扫描器") && String(page.text).includes("结果工作台") && Number(page.rows) > 0;
  const result = { status: rendered && Number(page.brokenImages || 0) === 0 && consoleErrors.length === 0 && pageErrors.length === 0 && requestFailures.length === 0 ? "PASS" : "FAIL", url: targetUrl, title: page.title || "", tableRows: Number(page.rows || 0), staticScripts: Number(page.scripts || 0), staticStyles: Number(page.styles || 0), brokenImages: Number(page.brokenImages || 0), consoleErrors, pageErrors, requestFailures };
  fs.mkdirSync(path.join(process.cwd(), "logs"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "logs", "browser-smoke.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (result.status !== "PASS") process.exitCode = 1;
  socketClose(cdp);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (!browser.killed) browser.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still release profile files */ }
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  const ready = new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", (message) => {
    const value = JSON.parse(String(message.data));
    if (value.id) { const waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); if (value.error) waiter.reject(new Error(value.error.message)); else waiter.resolve(value.result); } return; }
    for (const handler of handlers.get(value.method) || []) handler(value.params || {});
  });
  return {
    ready,
    send(method, params = {}) { return new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); }); },
    on(method, handler) { handlers.set(method, [...(handlers.get(method) || []), handler]); },
    once(method, timeoutMs) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs); const handler = (value) => { clearTimeout(timer); handlers.set(method, (handlers.get(method) || []).filter((item) => item !== handler)); resolve(value); }; handlers.set(method, [...(handlers.get(method) || []), handler]); }); },
  };
}

async function waitForJson(url, timeoutMs) { const end = Date.now() + timeoutMs; while (Date.now() < end) { try { const response = await fetch(url); if (response.ok) return await response.json(); } catch { /* starting */ } await delay(150); } throw new Error("浏览器调试端口启动超时"); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fail(message) { console.error(JSON.stringify({ status: "FAIL", error: message, browserStderr: browserStderr?.slice(0, 500) || "" })); process.exitCode = 1; }
function socketClose(cdp) { void cdp.send("Page.stopLoading").catch(() => undefined); }
