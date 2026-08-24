import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [nodeExe, nextCli, portText, instanceId, startedAt] = process.argv.slice(2);
const projectRoot = process.cwd();
const runtimeDir = path.join(projectRoot, "runtime");
const logsDir = path.join(projectRoot, "logs");
const stopMarker = path.join(runtimeDir, "stop.requested");
const supervisorState = path.join(runtimeDir, "supervisor.json");
const serverState = path.join(runtimeDir, "server.json");
const lifecycleLog = path.join(logsDir, "process-lifecycle.log");
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

let child = null;
let restartCount = 0;
let intentionalStop = false;
const log = (event, details = {}) => {
  try { fs.appendFileSync(lifecycleLog, `${new Date().toISOString()} event=${event} ${JSON.stringify(details)}\n`, "utf8"); } catch { /* diagnostics only */ }
};
const writeState = () => {
  try { fs.writeFileSync(supervisorState, JSON.stringify({ supervisorPid: process.pid, childPid: child?.pid ?? null, port: Number(portText), instanceId, startedAt, restartCount }, null, 2)); } catch (error) { log("STATE_WRITE_FAILED", { message: error instanceof Error ? error.message : String(error) }); }
};

function launch() {
  if (intentionalStop || fs.existsSync(stopMarker)) { log("STOP_MARKER_OBSERVED"); process.exit(0); }
  const stdout = fs.openSync(path.join(logsDir, "server.log"), "a");
  const stderr = fs.openSync(path.join(logsDir, "server-error.log"), "a");
  child = spawn(nodeExe, [nextCli, "start", "--hostname", "0.0.0.0", "--port", portText], {
    cwd: projectRoot, detached: true, windowsHide: true, stdio: ["ignore", stdout, stderr],
    env: { ...process.env, DB_PATH: path.join(projectRoot, "data", "scanner.db"), NODE_USE_ENV_PROXY: "1", SCANNER_INSTANCE_ID: instanceId, SCANNER_STARTED_AT: startedAt },
  });
  fs.closeSync(stdout); fs.closeSync(stderr);
  writeState();
  setTimeout(() => {
    try {
      if (!fs.existsSync(serverState)) return;
      const state = JSON.parse(fs.readFileSync(serverState, "utf8").replace(/^\uFEFF/, ""));
      if (state.instanceId === instanceId && child?.pid) fs.writeFileSync(serverState, JSON.stringify({ ...state, pid: child.pid }, null, 2), "utf8");
    } catch (error) { log("SERVER_STATE_REFRESH_FAILED", { message: error instanceof Error ? error.message : String(error) }); }
  }, 2_000);
  log("CHILD_STARTED", { supervisorPid: process.pid, childPid: child.pid, port: Number(portText), instanceId, restartCount });
  child.on("error", (error) => log("CHILD_SPAWN_ERROR", { message: error.message }));
  child.on("exit", (code, signal) => {
    log("CHILD_EXIT", { childPid: child?.pid, code, signal, intentionalStop, stopMarker: fs.existsSync(stopMarker) });
    child = null; writeState();
    if (intentionalStop || fs.existsSync(stopMarker)) process.exit(0);
    restartCount += 1;
    if (restartCount > 10) { log("RESTART_LIMIT_REACHED", { restartCount }); process.exit(1); }
    setTimeout(launch, Math.min(10_000, restartCount * 1_000));
  });
}

for (const signal of ["SIGINT", "SIGBREAK"]) {
  process.on(signal, () => log("SUPERVISOR_SIGNAL_IGNORED", { signal, childPid: child?.pid }));
}
process.on("SIGTERM", () => { intentionalStop = true; log("SUPERVISOR_SIGTERM", { childPid: child?.pid }); process.exit(0); });
process.on("uncaughtException", (error) => log("SUPERVISOR_UNCAUGHT_EXCEPTION", { message: error.message, stack: error.stack }));
process.on("unhandledRejection", (error) => log("SUPERVISOR_UNHANDLED_REJECTION", { message: error instanceof Error ? error.message : String(error) }));
process.on("exit", (code) => log("SUPERVISOR_EXIT", { code, childPid: child?.pid }));
log("SUPERVISOR_STARTED", { supervisorPid: process.pid, port: Number(portText), instanceId });
launch();
