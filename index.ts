/**
 * ops-runner plugin
 * - Provides agent tools for systemd-run kickoff + status/journal
 * - Maintains shared job status JSON (kickoff + work)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename, open } from "node:fs/promises";

const execFileAsync = promisify(execFile);

type RestartPolicy = "never" | "safe" | "aggressive";

const MONITORS = new Map<string, NodeJS.Timeout>();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type JobNotifyPolicy = {
  mode?: "always" | "on_error" | "on_success" | "never";
  channel?: string; // e.g. "telegram"
  target?: string;  // chat id
  title?: string;   // override title prefix
  includeJournalTailLines?: number; // attach last N lines when error
};

type JobPolicy = {
  jobKey: string;
  unitBase: string;
  mode: "singleton" | "unique";

  // systemd-run will execute this argv array (no shell string)
  command: string[];

  // optional tuning
  maxRuntimeSec?: number;
  heartbeatIntervalSec?: number;
  heartbeatTtlSec?: number;
  staleGraceSec?: number;
  restartPolicy?: RestartPolicy;

  // Optional post-run hooks + notify (best-effort)
  postRunHooks?: string[]; // absolute paths
  notify?: JobNotifyPolicy;
};

type JobsRegistryV1 = {
  schemaVersion: 1;
  jobs: Record<string, JobPolicy>;
};

type JobStatusV1 = {
  schemaVersion: 1;
  jobKey: string;
  runId: string;
  status: "idle" | "starting" | "running" | "ok" | "error" | "stale";
  reason?: string;
  unitName: string;
  mainPid?: number;
  startedAt: string;
  heartbeatAt?: string;
  finishedAt?: string;
  exitCode?: number;
  summary?: string;
  artifacts?: Record<string, unknown>;

  // Post-run bookkeeping (avoid double-send / double-hook)
  postRunDoneAt?: string;
  notifyDoneAt?: string;
};

type MonitorStatusV1 = {
  jobKey: string;
  enabled: boolean;
  intervalSec: number;
  lastTickAt?: string;
};

function registryPath(): string {
  return join(stateDir(), "jobs.json");
}

const DEFAULTS = {
  heartbeatIntervalSec: 60,
  heartbeatTtlSec: 240,
  staleGraceSec: 30,
  restartPolicy: "safe" as RestartPolicy,

  // Security: only allow commands from these prefixes (no arbitrary /bin/bash -lc ...)
  // Default: workspace scripts (auditable under workspace-only). Users can widen if needed.
  allowedCommandPrefixes: [join(homedir(), ".openclaw", "workspace", "scripts", "ops-runner")],
} as const;

function validateCommand(argv: string[]) {
  if (!Array.isArray(argv) || argv.length < 1) throw new Error("invalid_command");
  const cmd0 = argv[0];
  if (typeof cmd0 !== "string" || cmd0.length < 1) throw new Error("invalid_command");

  // absolute path required
  if (!cmd0.startsWith("/")) throw new Error("command_must_be_absolute");

  // prefix allowlist
  const ok = DEFAULTS.allowedCommandPrefixes.some((p) => cmd0 === p || cmd0.startsWith(p + "/"));
  if (!ok) {
    throw new Error(`command_not_allowed: ${cmd0}`);
  }
}

function validateHookPaths(paths: string[] | undefined) {
  if (!paths) return;
  if (!Array.isArray(paths)) throw new Error("invalid_postRunHooks");
  for (const p of paths) {
    if (typeof p !== "string" || !p) throw new Error("invalid_postRunHooks");
    if (!p.startsWith("/")) throw new Error("hook_must_be_absolute");
    const ok = DEFAULTS.allowedCommandPrefixes.some((pref) => p === pref || p.startsWith(pref + "/"));
    if (!ok) throw new Error(`hook_not_allowed: ${p}`);
  }
}

function normalizeJob(jobKey: string, j: JobPolicy): Required<JobPolicy> {
  // validate and normalize
  validateCommand(j.command);
  validateHookPaths(j.postRunHooks);

  return {
    jobKey,
    unitBase: j.unitBase,
    mode: j.mode,
    command: j.command,
    maxRuntimeSec: j.maxRuntimeSec ?? 0,
    heartbeatIntervalSec: j.heartbeatIntervalSec ?? DEFAULTS.heartbeatIntervalSec,
    heartbeatTtlSec: j.heartbeatTtlSec ?? DEFAULTS.heartbeatTtlSec,
    staleGraceSec: j.staleGraceSec ?? DEFAULTS.staleGraceSec,
    restartPolicy: j.restartPolicy ?? DEFAULTS.restartPolicy,

    postRunHooks: j.postRunHooks ?? [],
    notify: j.notify ?? { mode: "never" },
  };
}

async function readRegistry(): Promise<JobsRegistryV1> {
  await ensureStateDir();
  try {
    const raw = await readFile(registryPath(), "utf-8");
    const parsed = JSON.parse(raw) as JobsRegistryV1;
    if (parsed?.schemaVersion !== 1 || !parsed.jobs) throw new Error("bad_registry");
    return parsed;
  } catch {
    // Do NOT blindly overwrite registry with empty, to avoid accidental data loss.
    // Instead: try to restore from latest backup, otherwise initialize empty.
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "");
      const badPath = join(stateDir(), `jobs.json.bad.${ts}`);
      try {
        await rename(registryPath(), badPath);
      } catch {}

      // Try latest backup
      const files = await readdir(stateDir());
      const baks = files.filter((f) => f.startsWith("jobs.json.bak."))
        .sort()
        .reverse();
      if (baks.length > 0) {
        await copyFile(join(stateDir(), baks[0]), registryPath());
        const raw2 = await readFile(registryPath(), "utf-8");
        const parsed2 = JSON.parse(raw2) as JobsRegistryV1;
        if (parsed2?.schemaVersion === 1 && parsed2.jobs) return parsed2;
      }
    } catch {
      // ignore
    }

    const empty: JobsRegistryV1 = { schemaVersion: 1, jobs: {} };
    await writeRegistry(empty);
    return empty;
  }
}

function registryLockPath(): string {
  return join(stateDir(), "registry.lock");
}

async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureStateDir();
  const lp = registryLockPath();

  const holder = spawn(
    "/bin/bash",
    [
      "-lc",
      "set -euo pipefail; exec 9>\"$1\"; /usr/bin/flock -w 10 -x 9; echo LOCKED; cat >/dev/null",
      "bash",
      lp,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const waitLocked = await new Promise<boolean>((resolve) => {
    let buf = "";
    const done = (ok: boolean) => resolve(ok);
    const timer = setTimeout(() => done(false), 12_000);

    holder.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      if (buf.includes("LOCKED")) {
        clearTimeout(timer);
        done(true);
      }
    });

    holder.on("error", () => {
      clearTimeout(timer);
      done(false);
    });

    holder.on("exit", () => {
      clearTimeout(timer);
      done(false);
    });
  });

  if (!waitLocked) {
    try {
      holder.kill("SIGKILL");
    } catch {}
    throw new Error("registry_lock_timeout");
  }

  try {
    return await fn();
  } finally {
    try {
      holder.stdin?.end();
    } catch {}
  }
}

function registryTmpPath(): string {
  // unique tmp path to avoid writer contention
  const r = Math.random().toString(16).slice(2);
  return join(stateDir(), `.jobs.json.tmp.${process.pid}.${r}`);
}

async function writeRegistry(reg: JobsRegistryV1): Promise<void> {
  await ensureStateDir();
  const tmp = registryTmpPath();
  await writeFile(tmp, JSON.stringify(reg, null, 2) + "\n", "utf-8");
  await rename(tmp, registryPath());
}

async function getJob(jobKey: string): Promise<Required<JobPolicy>> {
  const reg = await readRegistry();
  const j = reg.jobs[jobKey];
  if (!j) throw new Error(`unknown_jobKey: ${jobKey}`);
  return normalizeJob(jobKey, j);
}

function shouldNotify(mode: string | undefined, rc: number): boolean {
  const m = mode ?? "never";
  if (m === "never") return false;
  if (m === "always") return true;
  if (m === "on_error") return rc !== 0;
  if (m === "on_success") return rc === 0;
  return false;
}

async function runPostRunHooks(jobKey: string, unitName: string, hooks: string[] | undefined): Promise<void> {
  validateHookPaths(hooks);
  if (!hooks || hooks.length === 0) return;

  for (const h of hooks) {
    try {
      await execFileAsync(h, [], { timeout: 120_000 });
    } catch {
      // best-effort; hook failures should not crash status tool
    }
  }
}

async function sendNotify(jobKey: string, unitName: string, st: JobStatusV1, unit: Record<string, string> | null, policy: Required<JobPolicy>): Promise<void> {
  const n = policy.notify;
  if (!n) return;

  const mode = n.mode ?? "never";
  const rc = typeof st.exitCode === "number" ? st.exitCode : 0;
  if (!shouldNotify(mode, rc)) return;

  const channel = n.channel ?? "telegram";
  const target = n.target ?? "";
  if (!target) return;

  const title = n.title ?? `ops-runner ${jobKey}`;
  const statusWord = st.status === "ok" ? "OK" : st.status === "error" ? "FAIL" : st.status;
  let msg = `${title}\n\n- jobKey: ${jobKey}\n- unit: ${unitName}\n- status: ${statusWord}\n- exitCode: ${rc}`;

  const tailN = Math.max(0, Math.min(400, Math.floor(n.includeJournalTailLines ?? 0)));
  if (tailN > 0 && st.status === "error") {
    try {
      const tail = await journalTail(unitName, tailN);
      if (tail.trim()) msg += `\n\n--- journal tail ---\n${tail}`;
    } catch {}
  }

  // Use OpenClaw message tool by invoking openclaw CLI (workspace wrapper is preferred but CLI availability varies).
  // We rely on system PATH first; if unavailable, skip (best-effort).
  const openclaw = await resolveOpenclawCli();
  if (!openclaw) return;

  try {
    await execFileAsync(openclaw, ["message", "send", "--channel", channel, "--target", target, "--message", msg], { timeout: 60_000 });
  } catch {
    // best-effort
  }
}

async function resolveOpenclawCli(): Promise<string | null> {
  const home = homedir();

  // Prefer workspace wrapper (best for systemd minimal PATH)
  const wrapper = join(home, ".openclaw", "workspace", "scripts", "bin", "openclaw");
  try {
    await execFileAsync("/usr/bin/test", ["-x", wrapper], { timeout: 5_000 });
    return wrapper;
  } catch {}

  // Prefer PATH
  try {
    const { stdout } = await execFileAsync("/usr/bin/env", ["bash", "-lc", "command -v openclaw || true"], { timeout: 10_000 });
    const p = stdout.trim();
    if (p) return p;
  } catch {}

  // Common fallback for this deployment
  const p2 = join(home, ".npm-global", "bin", "openclaw");
  try {
    await execFileAsync("/usr/bin/test", ["-x", p2], { timeout: 5_000 });
    return p2;
  } catch {}

  return null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function stateDir(): string {
  return join(homedir(), ".openclaw", "state", "ops-runner");
}

function statusPath(jobKey: string): string {
  return join(stateDir(), `${jobKey}.json`);
}

function lockPath(jobKey: string): string {
  // flock lock file (must be stable per jobKey)
  return join(stateDir(), `${jobKey}.lock`);
}

async function ensureStateDir() {
  await mkdir(stateDir(), { recursive: true });
}

/**
 * Lock implementation using util-linux `flock`.
 *
 * Why: O_EXCL lockfiles can be left behind; flock locks are released automatically if the lock-holder dies.
 *
 * Approach: spawn a tiny bash "lock holder" process that:
 * - opens the lock file on FD 9
 * - acquires an exclusive flock (timeout 10s)
 * - prints "LOCKED" then blocks reading stdin
 *
 * We keep that process alive while `fn()` runs; when we close stdin, the process exits and releases the lock.
 */
async function withLock<T>(jobKey: string, fn: () => Promise<T>): Promise<T> {
  await ensureStateDir();
  const lp = lockPath(jobKey);

  const holder = spawn(
    "/bin/bash",
    [
      "-lc",
      // $1 is lock path
      "set -euo pipefail; exec 9>\"$1\"; /usr/bin/flock -w 10 -x 9; echo LOCKED; cat >/dev/null",
      "bash",
      lp,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const waitLocked = await new Promise<boolean>((resolve) => {
    let buf = "";
    const done = (ok: boolean) => resolve(ok);

    const timer = setTimeout(() => done(false), 12_000);

    holder.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      if (buf.includes("LOCKED")) {
        clearTimeout(timer);
        done(true);
      }
    });

    holder.on("error", () => {
      clearTimeout(timer);
      done(false);
    });

    holder.on("exit", () => {
      clearTimeout(timer);
      done(false);
    });
  });

  if (!waitLocked) {
    try {
      holder.kill("SIGKILL");
    } catch {}
    throw new Error(`lock_timeout jobKey=${jobKey}`);
  }

  try {
    return await fn();
  } finally {
    try {
      holder.stdin?.end();
    } catch {}
    // best-effort wait; do not block forever
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function readStatus(jobKey: string): Promise<JobStatusV1 | null> {
  try {
    const raw = await readFile(statusPath(jobKey), "utf-8");
    return JSON.parse(raw) as JobStatusV1;
  } catch {
    return null;
  }
}

function monitorPath(jobKey: string): string {
  return join(stateDir(), `${jobKey}.monitor.json`);
}

async function readMonitor(jobKey: string): Promise<MonitorStatusV1 | null> {
  try {
    const raw = await readFile(monitorPath(jobKey), "utf-8");
    return JSON.parse(raw) as MonitorStatusV1;
  } catch {
    return null;
  }
}

async function writeMonitor(jobKey: string, st: MonitorStatusV1): Promise<void> {
  await ensureStateDir();
  const p = monitorPath(jobKey);
  const tmp = join(stateDir(), `.${jobKey}.monitor.json.tmp`);
  await writeFile(tmp, JSON.stringify(st, null, 2) + "\n", "utf-8");
  await rename(tmp, p);
}

async function writeStatus(jobKey: string, st: JobStatusV1): Promise<void> {
  await ensureStateDir();
  const p = statusPath(jobKey);
  const tmp = join(stateDir(), `.${jobKey}.json.tmp`);
  await writeFile(tmp, JSON.stringify(st, null, 2) + "\n", "utf-8");
  await rename(tmp, p);
}

function mkRunId(): string {
  // YYYYMMDD_HHMMSS_rand
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  return `${ts}_${rand}`;
}

async function systemctlShowUnit(unitName: string) {
  const { stdout } = await execFileAsync("/bin/systemctl", [
    "--user",
    "show",
    unitName,
    "-p",
    "LoadState",
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "MainPID",
    "-p",
    "Result",
    "-p",
    "ExecMainStatus",
    "-p",
    "ExecMainCode",
    "-p",
    "ExecMainStartTimestamp",
    "-p",
    "ExecMainExitTimestamp",
    "-p",
    "ExecMainPID",
    "--no-pager",
  ]);
  const m: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1);
  }
  return m;
}

function unitIsRunning(show: Record<string, string>): boolean {
  return (
    show.ActiveState === "activating" ||
    (show.ActiveState === "active" && (show.SubState === "running" || show.SubState === "start"))
  );
}

function unitHasFinished(show: Record<string, string>): boolean {
  // with --remain-after-exit, a successful completed unit is active/exited
  return (show.ActiveState === "active" && show.SubState === "exited") || show.ActiveState === "failed";
}

function unitOk(show: Record<string, string>): boolean {
  const execStatus = Number(show.ExecMainStatus ?? "NaN");
  const isFailed = show.ActiveState === "failed" || show.Result === "failed";
  return show.ActiveState === "active" && show.SubState === "exited" && Number.isFinite(execStatus) && execStatus === 0 && !isFailed;
}

function unitServiceName(unitName: string): string {
  // normalize: allow passing either "foo" or "foo.service"
  return unitName.includes(".") ? unitName : `${unitName}.service`;
}

async function systemdRun(unitName: string, argv: string[]) {
  if (!Array.isArray(argv) || argv.length < 1) throw new Error("invalid_command");
  const args = ["--user", `--unit=${unitName}`, "--remain-after-exit", "--", ...argv];
  await execFileAsync("/bin/systemd-run", args, { timeout: 30_000 });
}

async function systemctlRestartUnit(unitName: string) {
  await execFileAsync(
    "/bin/systemctl",
    ["--user", "restart", unitServiceName(unitName), "--no-pager"],
    { timeout: 30_000 },
  );
}

async function ensureUnitStarted(unitName: string, argv: string[]): Promise<"alreadyRunning" | "restarted" | "created"> {
  try {
    const show = await systemctlShowUnit(unitName);
    if (show.LoadState === "loaded") {
      if (unitIsRunning(show)) return "alreadyRunning";

      // Important for --remain-after-exit: unit can be ActiveState=active/SubState=exited.
      // In that case, we want to re-run it via restart (not systemd-run with same unit name).
      await systemctlRestartUnit(unitName);
      return "restarted";
    }
  } catch {
    // ignore and fall back to systemd-run
  }

  await systemdRun(unitName, argv);
  return "created";
}

function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function isHeartbeatFresh(nowMs: number, hbIso: string | undefined, ttlSec: number, graceSec: number): boolean {
  const hb = parseMs(hbIso);
  if (!hb) return false;
  return nowMs - hb <= (ttlSec + graceSec) * 1000;
}

function isStartedOverMax(nowMs: number, startedIso: string | undefined, maxRuntimeSec?: number): boolean {
  if (!maxRuntimeSec) return false;
  const s = parseMs(startedIso);
  if (!s) return false;
  return nowMs - s > maxRuntimeSec * 1000;
}

async function kickoffJob(jobKey: string): Promise<{ unitName: string; alreadyRunning: boolean; status: JobStatusV1 }>{
  const policy = await getJob(jobKey);

  return await withLock(jobKey, async () => {
    const nowMs = Date.now();
    const existing = await readStatus(jobKey);

    const unitName = policy.mode === "singleton" ? policy.unitBase : `${policy.unitBase}@${mkRunId()}`;

    // If singleton, check existing status + unit
    if (policy.mode === "singleton" && existing && (existing.status === "starting" || existing.status === "running")) {
      try {
        const show = await systemctlShowUnit(existing.unitName);
        const active = show.ActiveState === "active" && show.SubState === "running";
        if (active) {
          const st: JobStatusV1 = {
            ...existing,
            reason: "already_running",
            mainPid: Number(show.MainPID || existing.mainPid || 0) || existing.mainPid,
          };
          await writeStatus(jobKey, st);
          return { unitName: existing.unitName, alreadyRunning: true, status: st };
        }

        // unit exited/failed but status not finalized => stale
        const staleByUnitExit = (show.ActiveState === "inactive" || show.ActiveState === "failed") && !existing.finishedAt;
        const staleByHeartbeat = !isHeartbeatFresh(nowMs, existing.heartbeatAt, policy.heartbeatTtlSec, policy.staleGraceSec);
        const staleByMax = isStartedOverMax(nowMs, existing.startedAt, policy.maxRuntimeSec);

        if (staleByUnitExit || staleByMax || (staleByHeartbeat && policy.restartPolicy !== "never")) {
          const stStale: JobStatusV1 = { ...existing, status: "stale", reason: "recovered_from_stale" };
          await writeStatus(jobKey, stStale);
          // proceed to start a new run below
        } else if (staleByHeartbeat && policy.restartPolicy === "never") {
          const stSus: JobStatusV1 = { ...existing, reason: "suspected_stuck" };
          await writeStatus(jobKey, stSus);
          return { unitName: existing.unitName, alreadyRunning: true, status: stSus };
        }
      } catch {
        // If systemctl show fails, fall through to try starting new run (but mark stale conservatively)
      }
    }

    const runId = mkRunId();
    const startedAt = isoNow();
    const stStarting: JobStatusV1 = {
      schemaVersion: 1,
      jobKey,
      runId,
      status: "starting",
      reason: "kickoff",
      unitName,
      startedAt,
      heartbeatAt: startedAt,
    };
    await writeStatus(jobKey, stStarting);

    // Execute argv via systemd-run (no shell string)
    const startDisposition = await ensureUnitStarted(unitName, policy.command);

    // best-effort: read unit MainPID
    let mainPid: number | undefined;
    try {
      const show = await systemctlShowUnit(unitName);
      const n = Number(show.MainPID || 0);
      if (n > 0) mainPid = n;
    } catch {}

    const reasonShort =
      startDisposition === "alreadyRunning"
        ? "already_running"
        : startDisposition === "restarted"
          ? "restarted_exited_unit"
          : "created_unit";

    const stRunning: JobStatusV1 = {
      ...stStarting,
      status: "running",
      reason: reasonShort,
      mainPid,
      heartbeatAt: isoNow(),
    };
    await writeStatus(jobKey, stRunning);

    return { unitName, alreadyRunning: false, status: stRunning };
  });
}

async function statusJob(jobKey: string) {
  const policy = await getJob(jobKey);

  return await withLock(jobKey, async () => {
    const st = await readStatus(jobKey);
    if (!st) return { status: null, unit: null };

    let unit: Record<string, string> | null = null;
    try {
      unit = await systemctlShowUnit(st.unitName);
    } catch {
      unit = null;
    }

    const nowMs = Date.now();
    const staleByHeartbeat = !isHeartbeatFresh(nowMs, st.heartbeatAt, policy.heartbeatTtlSec, policy.staleGraceSec);
    const staleByMax = isStartedOverMax(nowMs, st.startedAt, policy.maxRuntimeSec);

    // If running and stale conditions met: optionally try to recover.
    // We only do automatic recovery when restartPolicy != never.
    if (unit && !st.finishedAt && (st.status === "starting" || st.status === "running")) {
      const running = unitIsRunning(unit);

      if (running && (staleByMax || staleByHeartbeat)) {
        if (policy.restartPolicy === "never") {
          const stSus: JobStatusV1 = { ...st, reason: "suspected_stuck" };
          await writeStatus(jobKey, stSus);
          return { status: stSus, unit };
        }

        // Attempt a single restart (safe) and mark as stale->recovered.
        try {
          await systemctlRestartUnit(st.unitName);
          const stRec: JobStatusV1 = { ...st, status: "stale", reason: "restarted_stale" };
          await writeStatus(jobKey, stRec);
          return { status: stRec, unit };
        } catch {
          const stStale: JobStatusV1 = { ...st, status: "stale", reason: "stale_restart_failed" };
          await writeStatus(jobKey, stStale);
          return { status: stStale, unit };
        }
      }
    }

    // Finalize status based on unit truth (exited/failed).
    if (unit && !st.finishedAt && unitHasFinished(unit)) {
      const ok = unitOk(unit);
      const execStatus = Number(unit.ExecMainStatus ?? "NaN");
      let stFinal: JobStatusV1 = {
        ...st,
        status: ok ? "ok" : "error",
        finishedAt: isoNow(),
        exitCode: Number.isFinite(execStatus) ? execStatus : st.exitCode,
        reason: ok ? "finished_ok" : `failed_${unit.Result ?? "unknown"}`,
      };

      // Post-run hooks + notify are best-effort and should run at most once.
      // We write a marker to status to avoid double-send when status tool is called repeatedly.
      try {
        if (!stFinal.postRunDoneAt && policy.postRunHooks && policy.postRunHooks.length) {
          await runPostRunHooks(jobKey, stFinal.unitName, policy.postRunHooks);
          stFinal = { ...stFinal, postRunDoneAt: isoNow() };
        }
      } catch {
        // ignore
      }

      try {
        if (!stFinal.notifyDoneAt && policy.notify && policy.notify.mode && policy.notify.mode !== "never") {
          await sendNotify(jobKey, stFinal.unitName, stFinal, unit, policy);
          stFinal = { ...stFinal, notifyDoneAt: isoNow() };
        }
      } catch {
        // ignore
      }

      await writeStatus(jobKey, stFinal);
      return { status: stFinal, unit };
    }

    return { status: st, unit };
  });
}

async function journalTail(unitName: string, lines: number) {
  const { stdout } = await execFileAsync(
    "/bin/journalctl",
    ["--user", "-u", unitName, "-n", String(lines), "--no-pager"],
    { timeout: 30_000 },
  );
  return stdout;
}

async function monitorTick(jobKey: string) {
  let policy: Required<JobPolicy>;
  try {
    policy = await getJob(jobKey);
  } catch {
    return;
  }

  // Update heartbeat if unit still running.
  await withLock(jobKey, async () => {
    const st = await readStatus(jobKey);
    if (!st || st.finishedAt) return;

    let unit: Record<string, string> | null = null;
    try {
      unit = await systemctlShowUnit(st.unitName);
    } catch {
      unit = null;
    }

    if (unit && unitIsRunning(unit)) {
      const st2: JobStatusV1 = { ...st, heartbeatAt: isoNow() };
      await writeStatus(jobKey, st2);
    }
  });
}

function ensureMonitor(jobKey: string, intervalSec: number) {
  const key = `${jobKey}`;
  if (MONITORS.has(key)) return;

  const t = setInterval(() => {
    void monitorTick(jobKey).catch(() => {});
  }, Math.max(5, intervalSec) * 1000);

  MONITORS.set(key, t);
}

function stopMonitor(jobKey: string) {
  const t = MONITORS.get(jobKey);
  if (t) {
    clearInterval(t);
    MONITORS.delete(jobKey);
  }
}

const opsRunnerPlugin = {
  register(api: OpenClawPluginApi) {
    // Optional tools: side effects (systemd-run)
    api.registerTool(
      {
        name: "ops_runner_kickoff",
        description: "Kickoff a long-running ops job via systemd-run with shared job status state (dedupe + stale detection).",
        parameters: Type.Object({
          jobKey: Type.String({ description: "Known jobKey (allowlist)" }),
        }),
        async execute(_id, params) {
          const { jobKey } = params as { jobKey: string };
          const r = await kickoffJob(jobKey);
          return {
            content: [
              {
                type: "text",
                text:
                  `ops-runner kickoff\n` +
                  `- jobKey: ${jobKey}\n` +
                  `- unit: ${r.unitName}\n` +
                  `- alreadyRunning: ${r.alreadyRunning}\n` +
                  `- status: ${r.status.status}\n` +
                  `\nCheck:\n` +
                  `systemctl --user status ${r.unitName}.service --no-pager -l\n` +
                  `journalctl --user -u ${r.unitName}.service -n 200 --no-pager\n`,
              },
            ],
            details: { unitName: r.unitName, alreadyRunning: r.alreadyRunning, status: r.status },
          };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "ops_runner_status",
        description: "Read current job status + systemd unit show output.",
        parameters: Type.Object({
          jobKey: Type.String(),
        }),
        async execute(_id, params) {
          const { jobKey } = params as { jobKey: string };
          const r = await statusJob(jobKey);
          return {
            content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
            details: r,
          };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "ops_runner_journal",
        description: "Tail journal for the current unit of a jobKey (or a specific unitName).",
        parameters: Type.Object({
          jobKey: Type.Optional(Type.String()),
          unitName: Type.Optional(Type.String()),
          lines: Type.Optional(Type.Number({ default: 200 })),
        }),
        async execute(_id, params) {
          const { jobKey, unitName, lines = 200 } = params as { jobKey?: string; unitName?: string; lines?: number };
          let u = unitName;
          if (!u) {
            if (!jobKey) throw new Error("jobKey or unitName required");
            const st = await readStatus(jobKey);
            if (!st) throw new Error(`no status for jobKey=${jobKey}`);
            u = st.unitName;
          }
          const out = await journalTail(u, Math.max(1, Math.min(5000, Math.floor(lines))));
          return { content: [{ type: "text", text: out }] };
        },
      },
      { optional: true },
    );

    // Monitor controls (optional): keep status heartbeatAt fresh while unit is running.
    api.registerTool(
      {
        name: "ops_runner_monitor",
        description: "Enable/disable a lightweight heartbeat monitor (updates heartbeatAt while unit is running).",
        parameters: Type.Object({
          jobKey: Type.String(),
          enabled: Type.Optional(Type.Boolean({ default: true })),
          intervalSec: Type.Optional(Type.Number({ default: 30 })),
        }),
        async execute(_id, params) {
          const { jobKey, enabled = true, intervalSec = 30 } = params as { jobKey: string; enabled?: boolean; intervalSec?: number };
          await getJob(jobKey); // validate exists

          if (enabled) {
            ensureMonitor(jobKey, intervalSec);
          } else {
            stopMonitor(jobKey);
          }

          const st: MonitorStatusV1 = {
            jobKey,
            enabled,
            intervalSec: Math.max(5, Math.floor(intervalSec)),
            lastTickAt: isoNow(),
          };
          await writeMonitor(jobKey, st);

          return {
            content: [
              {
                type: "text",
                text:
                  `ops-runner monitor\n` +
                  `- jobKey: ${jobKey}\n` +
                  `- enabled: ${enabled}\n` +
                  `- intervalSec: ${st.intervalSec}\n`,
              },
            ],
            details: st,
          };
        },
      },
      { optional: true },
    );

    // Job registry CRUD
    api.registerTool(
      {
        name: "ops_runner_job_list",
        description: "List ops-runner registered jobs.",
        parameters: Type.Object({}),
        async execute() {
          const reg = await readRegistry();
          const keys = Object.keys(reg.jobs).sort();
          return {
            content: [
              {
                type: "text",
                text: `ops-runner jobs (${keys.length})\n` + keys.map((k) => `- ${k}`).join("\n") + "\n",
              },
            ],
            details: { keys, registry: reg },
          };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "ops_runner_job_add",
        description: "Add a new ops-runner job to the registry.",
        parameters: Type.Object({
          jobKey: Type.String(),
          unitBase: Type.String(),
          mode: Type.Union([Type.Literal("singleton"), Type.Literal("unique")]),
          command: Type.Array(Type.String(), { minItems: 1 }),
          maxRuntimeSec: Type.Optional(Type.Number()),
          heartbeatIntervalSec: Type.Optional(Type.Number()),
          heartbeatTtlSec: Type.Optional(Type.Number()),
          staleGraceSec: Type.Optional(Type.Number()),
          restartPolicy: Type.Optional(Type.Union([Type.Literal("never"), Type.Literal("safe"), Type.Literal("aggressive")])),
        }),
        async execute(_id, params) {
          const p = params as JobPolicy;
          validateCommand(p.command);
          return await withRegistryLock(async () => {
            const reg = await readRegistry();
            if (reg.jobs[p.jobKey]) throw new Error(`job_exists: ${p.jobKey}`);
            reg.jobs[p.jobKey] = p;
            await writeRegistry(reg);
            return { content: [{ type: "text", text: `job added\n- jobKey: ${p.jobKey}\n` }], details: { job: p } };
          });
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "ops_runner_job_update",
        description: "Update an existing ops-runner job in the registry.",
        parameters: Type.Object({
          jobKey: Type.String(),
          patch: Type.Record(Type.String(), Type.Any()),
        }),
        async execute(_id, params) {
          const { jobKey, patch } = params as { jobKey: string; patch: Record<string, any> };
          return await withRegistryLock(async () => {
            const reg = await readRegistry();
            const cur = reg.jobs[jobKey];
            if (!cur) throw new Error(`unknown_jobKey: ${jobKey}`);
            const next = { ...cur, ...patch, jobKey } as any;
            if (next.command) validateCommand(next.command);
            if (next.postRunHooks) validateHookPaths(next.postRunHooks);
            reg.jobs[jobKey] = next;
            await writeRegistry(reg);
            return { content: [{ type: "text", text: `job updated\n- jobKey: ${jobKey}\n` }], details: { jobKey, job: reg.jobs[jobKey] } };
          });
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "ops_runner_job_remove",
        description: "Remove an ops-runner job from the registry.",
        parameters: Type.Object({
          jobKey: Type.String(),
        }),
        async execute(_id, params) {
          const { jobKey } = params as { jobKey: string };
          return await withRegistryLock(async () => {
            const reg = await readRegistry();
            if (!reg.jobs[jobKey]) throw new Error(`unknown_jobKey: ${jobKey}`);
            delete reg.jobs[jobKey];
            await writeRegistry(reg);
            stopMonitor(jobKey);
            return { content: [{ type: "text", text: `job removed\n- jobKey: ${jobKey}\n` }], details: { jobKey } };
          });
        },
      },
      { optional: true },
    );
  },
};

export default opsRunnerPlugin;
