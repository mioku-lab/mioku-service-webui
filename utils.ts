import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PackageManager, WebUISettings } from "./types";
import {
  getServiceConfigDir,
  getServiceDataDir,
  getConfigDir,
  getDataDir,
  runCommand as runMiokuCommand,
} from "mioku";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const SETTINGS_PATH = path.join(
  getServiceConfigDir("webui"),
  "settings.json",
);
export const AUTH_PATH = path.join(getServiceConfigDir("webui"), "auth.json");
export const ROOT_PACKAGE_PATH = path.join(process.cwd(), "package.json");
export const LOCAL_CONFIG_PATH = path.join(getConfigDir(), "mioku.json");

export const WEBUI_DIST = path.join(__dirname, "dist");
export const CONFIG_DIR = getConfigDir();
export const DATA_DIR = getDataDir();
export const PLUGINS_DIR = path.join(process.cwd(), "plugins");
export const SERVICES_DIR = path.join(process.cwd(), "node_modules");
export const CHAT_CONFIG_DIR = path.join(getConfigDir(), "chat");
export const CHAT_DATA_DIR = path.join(getDataDir(), "chat");
export const LOGS_DIR = path.join(process.cwd(), "logs");
export const NODE_MODULES_DIR = path.join(process.cwd(), "node_modules");
export const TEMP_DIR = path.join(process.cwd(), "temp");
export const BACKUP_DIR = path.join(process.cwd(), "backup");

export const defaultWebUISettings: WebUISettings = {
  port: 3339,
  host: "127.0.0.1",
  packageManager: "bun" as PackageManager,
};

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function safeNameFromRepo(repoUrl: string): string {
  const last = repoUrl.split("/").pop() || "package";
  return last.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function normalizeManagedPackageName(
  repoUrl: string,
  target: "plugin" | "service",
): string {
  const raw = safeNameFromRepo(repoUrl);
  if (target === "plugin" && raw.startsWith("mioku-plugin-")) {
    return raw.slice("mioku-plugin-".length) || raw;
  }
  if (target === "service" && raw.startsWith("mioku-service-")) {
    return raw.slice("mioku-service-".length) || raw;
  }
  return raw;
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runMiokuCommand(command, args, { cwd });
}

export function getInstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "bun", args: ["add"] };
}

export function normalizePackageManager(): PackageManager {
  return "bun";
}

export function isValidRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  // 拒绝空白字符：堵 `ssh://host -o ProxyCommand=...` 之类参数注入
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }

  if (/^https?:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return Boolean(parsed.hostname) && !parsed.hostname.startsWith("-");
    } catch {
      return false;
    }
  }

  const sshMatch = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)/);
  if (sshMatch) {
    return !sshMatch[1].startsWith("-");
  }

  const scpMatch = trimmed.match(/^git@([^:]+):.+/);
  if (scpMatch) {
    return !scpMatch[1].startsWith("-");
  }

  return false;
}

export function isNpmPackageName(name: string): boolean {
  const npmPackageRegex = /^[a-z0-9@._-]+$/;
  return npmPackageRegex.test(name.trim().toLowerCase());
}

export function resolveNpmPackageName(
  name: string,
  target: "plugin" | "service" | "adapter",
): string {
  const prefix =
    target === "plugin"
      ? "mioku-plugin-"
      : target === "service"
        ? "mioku-service-"
        : "mioku-adapter-";
  if (name.startsWith(prefix)) {
    return name;
  }
  return `${prefix}${name}`;
}
