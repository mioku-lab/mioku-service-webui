import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "mioki";

const execFileAsync = promisify(execFile);

export interface FreePortLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface FreePortOptions {
  logger?: FreePortLogger;
  graceMs?: number;
  sigkillDelayMs?: number;
}

export interface FreePortResult {
  port: number;
  wasOccupied: boolean;
  killedPids: number[];
  remainingPids: number[];
  lsofAvailable: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePids(raw: string): number[] {
  const pids = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pid = Number(trimmed);
    if (Number.isFinite(pid) && pid > 0 && Math.floor(pid) === pid) {
      pids.add(pid);
    }
  }
  return Array.from(pids);
}

function parseNetstatPids(raw: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    if (!/^LISTENING$/i.test(cols[3])) continue;
    // Local address is host:port — IPv6 forms look like [::]:3339.
    const localPort = cols[1].slice(cols[1].lastIndexOf(":") + 1);
    if (Number(localPort) !== port) continue;
    const pid = Number(cols[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return Array.from(pids);
}

async function listListeningPids(
  port: number,
): Promise<{ pids: number[]; lsofAvailable: boolean }> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"]);
      return { pids: parseNetstatPids(stdout, port), lsofAvailable: true };
    } catch (err: any) {
      return { pids: [], lsofAvailable: err?.code !== "ENOENT" };
    }
  }

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    return { pids: parsePids(stdout), lsofAvailable: true };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { pids: [], lsofAvailable: false };
    }
    return { pids: [], lsofAvailable: true };
  }
}

async function sendSignal(
  pid: number,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function freePort(
  port: number,
  options: FreePortOptions = {},
): Promise<FreePortResult> {
  const log = options.logger ?? (logger as unknown as FreePortLogger);
  const graceMs = options.graceMs ?? 1500;
  const sigkillDelayMs = options.sigkillDelayMs ?? 500;

  const initial = await listListeningPids(port);

  if (!initial.lsofAvailable) {
    const missing = process.platform === "win32" ? "netstat" : "lsof";
    log.warn(
      `未检测到 ${missing} 命令，无法定位端口 ${port} 的占用进程，建议安装 ${missing}`,
    );
    return {
      port,
      wasOccupied: false,
      killedPids: [],
      remainingPids: [],
      lsofAvailable: false,
    };
  }

  const occupied = initial.pids.filter((pid) => pid !== process.pid);
  if (occupied.length === 0) {
    return {
      port,
      wasOccupied: false,
      killedPids: [],
      remainingPids: [],
      lsofAvailable: true,
    };
  }

  log.warn(
    `端口 ${port} 被占用，进程 PID: ${occupied.join(", ")}，正在尝试结束...`,
  );

  const killed: number[] = [];
  for (const pid of occupied) {
    if (await sendSignal(pid, "SIGTERM")) {
      killed.push(pid);
    }
  }

  if (killed.length > 0) {
    await sleep(graceMs);
  }

  let remaining = (await listListeningPids(port)).pids.filter(
    (pid) => pid !== process.pid,
  );

  if (remaining.length > 0) {
    log.warn(
      `端口 ${port} 仍被占用 (PID: ${remaining.join(", ")})，发送 SIGKILL 强制结束...`,
    );
    for (const pid of remaining) {
      if (await sendSignal(pid, "SIGKILL")) {
        killed.push(pid);
      }
    }
    await sleep(sigkillDelayMs);
    remaining = (await listListeningPids(port)).pids.filter(
      (pid) => pid !== process.pid,
    );
  }

  if (remaining.length > 0) {
    log.error(
      `端口 ${port} 仍被占用，无法结束进程 PID: ${remaining.join(", ")}`,
    );
  } else {
    log.info(`端口 ${port} 已释放`);
  }

  return {
    port,
    wasOccupied: true,
    killedPids: killed,
    remainingPids: remaining,
    lsofAvailable: true,
  };
}
