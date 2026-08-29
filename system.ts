import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import AdmZip from "adm-zip";
import systemInfo from "systeminformation";
import {connectedBots,
  logger} from "mioku";
import type {
  InstallRequest,
  ManagedTarget,
  PackageManager,
  RemoveRequest,
  UpdateRequest,
  WebUISettings,
} from "./types";
import {
  AUTH_PATH,
  CHAT_CONFIG_DIR,
  defaultWebUISettings,
  ensureDir,
  getInstallCommand,
  isNpmPackageName,
  isValidRepoUrl,
  LOCAL_CONFIG_PATH,
  NODE_MODULES_DIR,
  normalizeManagedPackageName,
  PLUGINS_DIR,
  readJsonFile,
  resolveNpmPackageName,
  ROOT_PACKAGE_PATH,
  runCommand,
  SERVICES_DIR,
  SETTINGS_PATH,
  WEBUI_DIST,
  writeJsonFile,
} from "./utils";
import * as fsp from "node:fs/promises";

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "mioku-store",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP_${res.status}`);
  }
  return res.json();
}

function normalizeRepositoryUrl(repository: any): string {
  if (!repository) return "";
  let raw = "";
  if (typeof repository === "string") {
    raw = repository;
  } else if (typeof repository?.url === "string") {
    raw = repository.url;
  }
  if (!raw) return "";

  let url = raw.trim().replace(/^git\+/, "");
  if (url.startsWith("git@")) {
    const matched = url.match(/^git@([^:]+):(.+)$/);
    if (matched) {
      url = `https://${matched[1]}/${matched[2]}`;
    }
  }
  if (url.startsWith("ssh://git@")) {
    url = url.replace(/^ssh:\/\/git@/, "https://").replace(/:/, "/");
  }
  return url.replace(/\.git$/, "");
}

interface NapcatNodeConfig {
  name?: string;
  host?: string;
  port?: number;
  token?: string;
  protocol?: string;
}

interface MiokiRuntimeConfig {
  mioki?: {
    napcat?: NapcatNodeConfig[];
    [key: string]: any;
  };
  [key: string]: any;
}

const SYSTEM_PLUGIN_NAMES = new Set(["chat", "help"]);
const SYSTEM_SERVICE_NAMES = new Set(["ai", "config", "help", "screenshot"]);
const CORE_CONFIG_PATH = path.join(
  process.cwd(),
  "config",
  "core",
  "base.json",
);

export interface CoreSystemConfig {
  likeCommand: {
    enabled: boolean;
    keyword: string;
    likeTimes: number;
    reactionEmojiId: number;
  };
  friend: {
    autoApprove: boolean;
  };
  group: {
    minMemberCount: number;
  };
  autoUpdate: {
    enabled: boolean;
    time: string;
    frequency: "daily" | "weekly" | "monthly";
  };
}

const DEFAULT_CORE_SYSTEM_CONFIG: CoreSystemConfig = {
  likeCommand: {
    enabled: true,
    keyword: "赞我",
    likeTimes: 10,
    reactionEmojiId: 201,
  },
  friend: {
    autoApprove: true,
  },
  group: {
    minMemberCount: 0,
  },
  autoUpdate: {
    enabled: true,
    time: "03:00",
    frequency: "daily",
  },
};

function isContainerRuntime(): boolean {
  return fs.existsSync("/.dockerenv");
}

function isSystemPluginName(name: string): boolean {
  return SYSTEM_PLUGIN_NAMES.has(
    String(name || "")
      .trim()
      .toLowerCase(),
  );
}

function isSystemServiceName(name: string): boolean {
  return SYSTEM_SERVICE_NAMES.has(
    String(name || "")
      .trim()
      .toLowerCase(),
  );
}

function getTargetRoot(target: ManagedTarget): string {
  if (target === "plugin") return PLUGINS_DIR;
  if (target === "service") return SERVICES_DIR;
  return NODE_MODULES_DIR;
}

async function getCurrentBranchName(dir: string): Promise<string> {
  const branchRes = await runCommand("git", ["branch", "--show-current"], dir);
  if (branchRes.code !== 0) {
    return "unknown";
  }
  return String(branchRes.stdout || "").trim() || "unknown";
}

async function getDefaultRemoteBranch(dir: string): Promise<string> {
  const headRes = await runCommand(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    dir,
  );
  if (headRes.code !== 0) {
    return "main";
  }
  const ref = String(headRes.stdout || "").trim();
  return ref.split("/").pop() || "main";
}

async function resolveMiokuTargetRef(
  dir: string,
): Promise<{ currentBranch: string; targetRef: string; targetBranch: string }> {
  const currentBranch = await getCurrentBranchName(dir);
  if (currentBranch !== "unknown") {
    return {
      currentBranch,
      targetRef: `origin/${currentBranch}`,
      targetBranch: currentBranch,
    };
  }

  const targetBranch = await getDefaultRemoteBranch(dir);
  return {
    currentBranch,
    targetRef: `origin/${targetBranch}`,
    targetBranch,
  };
}

function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as any;
    }
  }
  return result;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeCoreSystemConfig(input: any): CoreSystemConfig {
  const merged = deepMerge(cloneJson(DEFAULT_CORE_SYSTEM_CONFIG), input || {});
  const validFreq = ["daily", "weekly", "monthly"].includes(
    merged?.autoUpdate?.frequency,
  );

  return {
    likeCommand: {
      enabled: Boolean(merged?.likeCommand?.enabled),
      keyword:
        typeof merged?.likeCommand?.keyword === "string" &&
        merged.likeCommand.keyword.trim()
          ? merged.likeCommand.keyword.trim()
          : DEFAULT_CORE_SYSTEM_CONFIG.likeCommand.keyword,
      likeTimes:
        typeof merged?.likeCommand?.likeTimes === "number" &&
        Number.isFinite(merged.likeCommand.likeTimes)
          ? merged.likeCommand.likeTimes
          : DEFAULT_CORE_SYSTEM_CONFIG.likeCommand.likeTimes,
      reactionEmojiId:
        typeof merged?.likeCommand?.reactionEmojiId === "number" &&
        Number.isFinite(merged.likeCommand.reactionEmojiId)
          ? merged.likeCommand.reactionEmojiId
          : DEFAULT_CORE_SYSTEM_CONFIG.likeCommand.reactionEmojiId,
    },
    friend: {
      autoApprove: Boolean(merged?.friend?.autoApprove),
    },
    group: {
      minMemberCount:
        typeof merged?.group?.minMemberCount === "number" &&
        Number.isFinite(merged.group.minMemberCount)
          ? merged.group.minMemberCount
          : DEFAULT_CORE_SYSTEM_CONFIG.group.minMemberCount,
    },
    autoUpdate: {
      enabled: Boolean(merged?.autoUpdate?.enabled),
      time:
        typeof merged?.autoUpdate?.time === "string" &&
        merged.autoUpdate.time.trim()
          ? merged.autoUpdate.time.trim()
          : DEFAULT_CORE_SYSTEM_CONFIG.autoUpdate.time,
      frequency: validFreq
        ? merged.autoUpdate.frequency
        : DEFAULT_CORE_SYSTEM_CONFIG.autoUpdate.frequency,
    },
  };
}

function readPackageJson(dir: string): any {
  const packagePath = path.join(dir, "package.json");
  if (!fs.existsSync(packagePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf-8"));
  } catch {
    return null;
  }
}

const WEBUI_PLUGIN_PREFIX = "mioku-plugin-";

function appendToMiokiPlugins(cwd: string, pkgName: string): boolean {
  if (!pkgName.startsWith(WEBUI_PLUGIN_PREFIX)) return false;
  const shortName = pkgName.slice(WEBUI_PLUGIN_PREFIX.length);

  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const mioki = pkg.mioki ?? {};
  const plugins = Array.isArray(mioki.plugins) ? [...mioki.plugins] : [];
  if (plugins.includes(shortName)) return false;

  plugins.push(shortName);
  pkg.mioki = { ...mioki, plugins };
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

function readRootPackageJson(): any {
  return JSON.parse(fs.readFileSync(ROOT_PACKAGE_PATH, "utf-8"));
}

function readMiokiPackageJson(): any | null {
  const candidates = [
    path.join(process.cwd(), "node_modules", "mioku", "package.json"),
    path.join(process.cwd(), "..", "node_modules", "mioku", "package.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf-8"));
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function readMiokuPackageJson(): any | null {
  const candidates = [
    path.join(process.cwd(), "node_modules", "mioku", "package.json"),
    path.join(process.cwd(), "..", "node_modules", "mioku", "package.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf-8"));
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function writeRootPackageJson(data: any): void {
  fs.writeFileSync(ROOT_PACKAGE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getWebUISettings(): WebUISettings {
  ensureDir(path.dirname(SETTINGS_PATH));
  const settings = readJsonFile<Record<string, unknown>>(
    SETTINGS_PATH,
    defaultWebUISettings as unknown as Record<string, unknown>,
  );
  const merged: WebUISettings = {
    port:
      typeof settings.port === "number" && Number.isFinite(settings.port)
        ? settings.port
        : defaultWebUISettings.port,
    host:
      typeof settings.host === "string" && settings.host.trim()
        ? settings.host
        : defaultWebUISettings.host,
    packageManager: "bun",
  };
  writeJsonFile(SETTINGS_PATH, merged);
  return merged;
}

export function updateWebUISettings(
  input: Partial<WebUISettings>,
): WebUISettings {
  const current = getWebUISettings();
  const next: WebUISettings = {
    port:
      typeof input.port === "number" && Number.isFinite(input.port)
        ? input.port
        : current.port,
    host:
      typeof input.host === "string" && input.host.trim()
        ? input.host
        : current.host,
    packageManager: "bun",
  };
  writeJsonFile(SETTINGS_PATH, next);
  return next;
}

export function getCoreSystemConfig(): CoreSystemConfig {
  ensureDir(path.dirname(CORE_CONFIG_PATH));
  const raw = readJsonFile<any>(CORE_CONFIG_PATH, DEFAULT_CORE_SYSTEM_CONFIG);
  const normalized = normalizeCoreSystemConfig(raw);
  writeJsonFile(CORE_CONFIG_PATH, normalized);
  return normalized;
}

export function updateCoreSystemConfig(
  input: Partial<CoreSystemConfig>,
): CoreSystemConfig {
  const current = getCoreSystemConfig();
  const next = normalizeCoreSystemConfig(deepMerge(current, input || {}));
  writeJsonFile(CORE_CONFIG_PATH, next);
  return next;
}

function checkDependentServices(packageJson: any): string[] {
  const services = packageJson?.mioku?.services;
  if (!Array.isArray(services)) {
    return [];
  }
  return services.filter((serviceName: string) => {
    const servicePath = path.join(SERVICES_DIR, serviceName);
    return !fs.existsSync(servicePath);
  });
}

function assertSafePackageName(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    throw new Error("名称不能为空");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error("名称格式非法");
  }
  return trimmed;
}

function npmPrefixOf(target: ManagedTarget): string {
  if (target === "plugin") return "mioku-plugin-";
  if (target === "service") return "mioku-service-";
  return "mioku-adapter-";
}

function fullPackageName(target: ManagedTarget, name: string): string {
  const prefix = npmPrefixOf(target);
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

function isNpmManagedName(name: string): boolean {
  return (
    name.startsWith("mioku-plugin-") ||
    name.startsWith("mioku-service-") ||
    name.startsWith("mioku-adapter-")
  );
}

function resolveManagedDir(target: ManagedTarget, name: string): string {
  const safeName = assertSafePackageName(name);
  const root = path.resolve(getTargetRoot(target));

  // 对于 npm 包，前端传入的是不带前缀的名称如 "chat"，需要还原完整包名
  const fullName = fullPackageName(target, safeName);

  const dir = path.resolve(root, fullName);
  if (!dir.startsWith(`${root}${path.sep}`)) {
    throw new Error("非法路径");
  }
  if (!fs.existsSync(dir)) {
    throw new Error("目录不存在");
  }
  return dir;
}

function getRepositoryFromPackage(pkg: any): string {
  const repository = pkg?.repository;
  if (!repository) return "";
  if (typeof repository === "string") return repository;
  if (typeof repository?.url === "string") return repository.url;
  return "";
}

async function getGitOriginUrl(dir: string): Promise<string> {
  const res = await runCommand("git", ["remote", "get-url", "origin"], dir);
  if (res.code !== 0) return "";
  return res.stdout.trim();
}

function resolveWebUIProjectDir(): string {
  return path.join(process.cwd(), "..", "mioku-webui");
}

function readInstalledWebUIVersion(): string {
  // First check version files in WEBUI_DIST (written after WebUI update)
  const versionFileCandidates = [
    path.join(WEBUI_DIST, "webui-version.json"),
    path.join(WEBUI_DIST, ".webui-version"),
  ];

  for (const versionFile of versionFileCandidates) {
    if (!fs.existsSync(versionFile)) continue;
    try {
      const raw = fs.readFileSync(versionFile, "utf-8").trim();
      if (!raw) continue;
      if (versionFile.endsWith(".json")) {
        const parsed = JSON.parse(raw);
        const version = String(parsed?.version || "").trim();
        if (version) return normalizeVersionSpec(version);
      } else {
        return normalizeVersionSpec(raw);
      }
    } catch {
      // ignore invalid version marker
    }
  }

  // Fallback: read from mioku-webui package.json directly.
  // The service runs from example/, so mioku-webui at the repo root is one
  // level up — same resolution as resolveWebUIProjectDir().
  const webuiProjectDir = resolveWebUIProjectDir();
  const webuiPkgPath = path.join(webuiProjectDir, "package.json");
  if (fs.existsSync(webuiPkgPath)) {
    const pkg = readPackageJson(webuiProjectDir);
    if (pkg?.version) return normalizeVersionSpec(pkg.version);
  }

  return "unknown";
}

function parseGitHubRepo(
  input: string,
): { owner: string; repo: string; fullName: string } | null {
  const url = String(input || "").trim();
  if (!url) return null;

  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i,
    /^git@github\.com: [^/]+\/([^/#?]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const matched = url.match(pattern);
    if (!matched) continue;
    const owner = matched[1];
    const repo = matched[2];
    if (!owner || !repo) continue;
    return { owner, repo, fullName: `${owner}/${repo}` };
  }

  return null;
}

function parseVersionParts(input: string): number[] {
  const normalized = normalizeVersionSpec(input).replace(/^v/i, "");
  const core = normalized.split("-")[0].split("+")[0];
  if (!core) return [];
  return core
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part) && part >= 0);
}

function isVersionNewer(latest: string, current: string): boolean {
  const latestParts = parseVersionParts(latest);
  const currentParts = parseVersionParts(current);
  const maxLen = Math.max(latestParts.length, currentParts.length, 3);

  for (let i = 0; i < maxLen; i += 1) {
    const a = latestParts[i] ?? 0;
    const b = currentParts[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }

  const latestNormalized = normalizeVersionSpec(latest).replace(/^v/i, "");
  const currentNormalized = normalizeVersionSpec(current).replace(/^v/i, "");
  return latestNormalized !== currentNormalized;
}

function hasUsableDistFiles(dir: string): boolean {
  return fs.existsSync(path.join(dir, "index.html"));
}

function resolveDistSourceDir(unpackDir: string): string | null {
  const directCandidates = [path.join(unpackDir, "dist"), unpackDir];
  for (const candidate of directCandidates) {
    if (hasUsableDistFiles(candidate)) {
      return candidate;
    }
  }

  const children = fs.existsSync(unpackDir)
    ? fs.readdirSync(unpackDir, { withFileTypes: true })
    : [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const childDir = path.join(unpackDir, child.name);
    const nestedDist = path.join(childDir, "dist");
    if (hasUsableDistFiles(nestedDist)) {
      return nestedDist;
    }
    if (hasUsableDistFiles(childDir)) {
      return childDir;
    }
  }

  return null;
}

function readReadmeFile(
  dir: string,
): { fileName: string; content: string } | null {
  const candidates = [
    "README.md",
    "README.MD",
    "readme.md",
    "README.txt",
    "README",
    "readme",
  ];

  for (const fileName of candidates) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return { fileName, content };
    } catch {
      return null;
    }
  }
  return null;
}

interface ManagedPackageUpdateInfo {
  state: "up-to-date" | "has-updates" | "unknown" | "no-git";
  hasUpdates: boolean;
  behind: number;
  changelog: string[];
  error?: string;
}

interface ManagedPackageUpdateCacheEntry {
  checkedAt: number;
  info: ManagedPackageUpdateInfo;
}

interface WebUIReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface WebUIUpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  releaseTag: string;
  releaseUrl: string;
  sourceRepo: string;
  hasUpdates: boolean;
  canUpdate: boolean;
  assetName: string;
  assetUrl: string;
  checkedAt: number;
  error?: string;
  proxiedAssetUrl?: string;
}

interface MiokuUpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  sourceRepo: string;
  currentBranch: string;
  targetRef: string;
  hasUpdates: boolean;
  behind: number;
  changelog: string[];
  checkedAt: number;
  error?: string;
}

const MANAGED_UPDATE_CACHE_TTL_MS = 120_000;
const managedPackageUpdateCache = new Map<
  string,
  ManagedPackageUpdateCacheEntry
>();
const managedOverviewRefreshInFlight = new Map<ManagedTarget, Promise<void>>();
const WEBUI_UPDATE_CACHE_TTL_MS = 60_000;
let webuiUpdateCache: WebUIUpdateCheckResult | null = null;
let webuiUpdateCheckInFlight: Promise<WebUIUpdateCheckResult> | null = null;
let webuiUpdatingInFlight: Promise<Record<string, any>> | null = null;
const MIOKU_UPDATE_CACHE_TTL_MS = 60_000;
let miokuUpdateCache: MiokuUpdateCheckResult | null = null;
let miokuUpdateCheckInFlight: Promise<MiokuUpdateCheckResult> | null = null;

function makeManagedUpdateCacheKey(
  target: ManagedTarget,
  name: string,
): string {
  return `${target}:${name}`;
}

function getCachedManagedUpdateInfo(
  target: ManagedTarget,
  name: string,
): ManagedPackageUpdateCacheEntry | null {
  return (
    managedPackageUpdateCache.get(makeManagedUpdateCacheKey(target, name)) ||
    null
  );
}

function setCachedManagedUpdateInfo(
  target: ManagedTarget,
  name: string,
  info: ManagedPackageUpdateInfo,
): void {
  managedPackageUpdateCache.set(makeManagedUpdateCacheKey(target, name), {
    checkedAt: Date.now(),
    info,
  });
}

function isManagedUpdateCacheFresh(
  entry: ManagedPackageUpdateCacheEntry | null,
): boolean {
  if (!entry) return false;
  return Date.now() - entry.checkedAt < MANAGED_UPDATE_CACHE_TTL_MS;
}

async function refreshManagedUpdatesInBackground(
  target: ManagedTarget,
  packages: Array<Record<string, any>>,
): Promise<void> {
  for (const item of packages) {
    const name = String(item.name || "");
    if (!name) continue;

    if (!item.hasGit) {
      setCachedManagedUpdateInfo(target, name, {
        state: "no-git",
        hasUpdates: false,
        behind: 0,
        changelog: [],
        error: "NOT_GIT_REPO",
      });
      continue;
    }

    try {
      const updateInfo = await getManagedPackageUpdateInfo(
        String(item.path || ""),
      );
      setCachedManagedUpdateInfo(target, name, updateInfo);
    } catch (error: any) {
      setCachedManagedUpdateInfo(target, name, {
        state: "unknown",
        hasUpdates: false,
        behind: 0,
        changelog: [],
        error: error?.message || "UPDATE_CHECK_FAILED",
      });
    }
  }
}

function scheduleManagedUpdatesRefresh(
  target: ManagedTarget,
  packages: Array<Record<string, any>>,
): void {
  if (managedOverviewRefreshInFlight.has(target)) return;

  const shouldRefresh = packages.some((item) => {
    if (!item.hasGit) return false;
    const cached = getCachedManagedUpdateInfo(target, String(item.name || ""));
    return !isManagedUpdateCacheFresh(cached);
  });

  if (!shouldRefresh) return;

  const job = refreshManagedUpdatesInBackground(target, packages).finally(
    () => {
      managedOverviewRefreshInFlight.delete(target);
    },
  );
  managedOverviewRefreshInFlight.set(target, job);
}

async function getManagedPackageUpdateInfo(
  dir: string,
): Promise<ManagedPackageUpdateInfo> {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    return {
      state: "no-git",
      hasUpdates: false,
      behind: 0,
      changelog: [],
      error: "NOT_GIT_REPO",
    };
  }

  const fetchRes = await runCommand("git", ["fetch", "--all"], dir);
  if (fetchRes.code !== 0) {
    return {
      state: "unknown",
      hasUpdates: false,
      behind: 0,
      changelog: [],
      error: `git fetch 失败: ${fetchRes.stderr || fetchRes.stdout}`.trim(),
    };
  }

  const compare = await runCommand(
    "git",
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    dir,
  );
  if (compare.code !== 0) {
    return {
      state: "unknown",
      hasUpdates: false,
      behind: 0,
      changelog: [],
      error: `无法比较更新: ${compare.stderr || compare.stdout}`.trim(),
    };
  }

  const parts = compare.stdout
    .trim()
    .split(/\s+/)
    .map((item) => Number(item));
  const behind = Number.isFinite(parts[1]) ? parts[1] : 0;

  const changelog = await runCommand(
    "git",
    ["log", "--oneline", "HEAD..@{u}", "-n", "30"],
    dir,
  );

  return {
    state: behind > 0 ? "has-updates" : "up-to-date",
    hasUpdates: behind > 0,
    behind,
    changelog: changelog.stdout.trim().split("\n").filter(Boolean),
  };
}

export function listManagedPackages(
  target: ManagedTarget,
): Array<Record<string, any>> {
  if (target === "plugin") {
    return listPluginsFromNodeModules();
  }
  if (target === "service") {
    return listServicesFromNodeModules();
  }
  if (target === "adapter") {
    return listAdaptersFromNodeModules();
  }
  const root = getTargetRoot(target);
  ensureDir(root);
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  return names.map((name) => {
    const fullPath = path.join(root, name);
    const pkg = readPackageJson(fullPath);
    return {
      name,
      path: fullPath,
      version: pkg?.version ?? "0.0.0",
      description: pkg?.description ?? "",
      hasGit: fs.existsSync(path.join(fullPath, ".git")),
      isSystemPlugin: false,
      isSystemService: target === "service" ? isSystemServiceName(name) : false,
      repository: getRepositoryFromPackage(pkg),
      requiredServices: pkg?.mioku?.services ?? [],
    };
  });
}

function listPluginsFromNodeModules(): Array<Record<string, any>> {
  const plugins: Array<Record<string, any>> = [];
  const modulesPath = NODE_MODULES_DIR;
  if (!fs.existsSync(modulesPath)) return plugins;

  const entries = fs.readdirSync(modulesPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("mioku-plugin-")) continue;
    const fullPath = path.join(modulesPath, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    const name = entry.name.replace(/^mioku-plugin-/, "");
    const pkg = readPackageJson(fullPath);
    plugins.push({
      name,
      path: fullPath,
      version: pkg?.version ?? "0.0.0",
      description: pkg?.description ?? "",
      hasGit: fs.existsSync(path.join(fullPath, ".git")),
      isSystemPlugin: isSystemPluginName(name),
      isSystemService: false,
      repository: getRepositoryFromPackage(pkg),
      requiredServices: pkg?.mioku?.services ?? [],
    });
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

function listServicesFromNodeModules(): Array<Record<string, any>> {
  const services: Array<Record<string, any>> = [];
  const modulesPath = NODE_MODULES_DIR;
  if (!fs.existsSync(modulesPath)) return services;

  const entries = fs.readdirSync(modulesPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("mioku-service-")) continue;
    const fullPath = path.join(modulesPath, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    const name = entry.name.replace(/^mioku-service-/, "");
    const pkg = readPackageJson(fullPath);
    services.push({
      name,
      path: fullPath,
      version: pkg?.version ?? "0.0.0",
      description: pkg?.description ?? "",
      hasGit: fs.existsSync(path.join(fullPath, ".git")),
      isSystemPlugin: false,
      isSystemService: isSystemServiceName(name),
      repository: getRepositoryFromPackage(pkg),
      requiredServices: pkg?.mioku?.services ?? [],
    });
  }
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

function listAdaptersFromNodeModules(): Array<Record<string, any>> {
  const adapters: Array<Record<string, any>> = [];
  const modulesPath = NODE_MODULES_DIR;
  if (!fs.existsSync(modulesPath)) return adapters;

  const entries = fs.readdirSync(modulesPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("mioku-adapter-")) continue;
    const fullPath = path.join(modulesPath, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    const name = entry.name.replace(/^mioku-adapter-/, "");
    const pkg = readPackageJson(fullPath);
    adapters.push({
      name,
      path: fullPath,
      version: pkg?.version ?? "0.0.0",
      description: pkg?.description ?? "",
      hasGit: fs.existsSync(path.join(fullPath, ".git")),
      isSystemPlugin: false,
      isSystemService: false,
      repository: getRepositoryFromPackage(pkg),
      requiredServices: pkg?.mioku?.services ?? [],
    });
  }
  return adapters.sort((a, b) => a.name.localeCompare(b.name));
}

export async function installManagedPackage(
  input: InstallRequest,
): Promise<Record<string, any>> {
  const installCmd = getInstallCommand();

  // NPM 包或 Git URL 都统一使用 bun add
  const pkgName = isNpmPackageName(input.repoUrl)
    ? resolveNpmPackageName(input.repoUrl, input.target)
    : input.repoUrl.trim();

  // bun add 需要在 example 目录（workspace root）执行
  const installDir = path.resolve(process.cwd());

  // 安装前记录现有依赖
  const beforePkg = readPackageJson(installDir);
  const beforeDeps = new Set([
    ...Object.keys(beforePkg?.dependencies || {}),
    ...Object.keys(beforePkg?.devDependencies || {}),
  ]);

  const install = await runCommand(
    installCmd.cmd,
    [...installCmd.args, pkgName],
    installDir,
  );

  if (install.code !== 0) {
    throw new Error(`bun add 失败: ${install.stderr || install.stdout}`);
  }

  // 读取 example/package.json 获取新增的包名
  const afterPkg = readPackageJson(installDir);
  const afterDeps = [
    ...Object.keys(afterPkg?.dependencies || {}),
    ...Object.keys(afterPkg?.devDependencies || {}),
  ];
  const installedName =
    afterDeps.find(
      (name) =>
        !beforeDeps.has(name) && isNpmManagedName(name),
    ) || pkgName;

  const packageJsonPath = path.join(
    NODE_MODULES_DIR,
    installedName,
    "package.json",
  );
  const packageJson = readPackageJson(packageJsonPath);
  const missingServices = checkDependentServices(packageJson);

  managedPackageUpdateCache.delete(
    makeManagedUpdateCacheKey(input.target, installedName),
  );

  let enabled = false;
  if (input.target === "plugin") {
    enabled = appendToMiokiPlugins(installDir, installedName);
  }

  return {
    ok: true,
    name: installedName,
    missingServices,
    packageManager: "bun",
    restartRequired: true,
    enabled,
    installOutput: install.stdout || install.stderr,
  };
}

export async function checkUpdate(
  name: string,
  target: ManagedTarget,
): Promise<Record<string, any>> {
  const isNpmPackage = isNpmManagedName(name);

  if (isNpmPackage) {
    // 使用 npm view 检查 npm 包更新
    const currentVersion = await runCommand(
      "bun",
      ["npm", "info", name, "version"],
      process.cwd(),
    );
    const latestVersion = await runCommand(
      "bun",
      ["npm", "info", name, "dist-tags.latest"],
      process.cwd(),
    );
    const current = currentVersion.stdout?.trim() || "";
    const latest = latestVersion.stdout?.trim() || "";
    const hasUpdates = current !== latest && latest !== "";

    return {
      ok: true,
      state: "npm",
      hasUpdates,
      behind: hasUpdates ? 1 : 0,
      changelog: [],
      hasGit: false,
      error: null,
      currentVersion: current,
      latestVersion: latest,
    };
  }

  const dir = resolveManagedDir(target, name);
  const result = await getManagedPackageUpdateInfo(dir);
  setCachedManagedUpdateInfo(target, name, result);
  return {
    ok: true,
    state: result.state,
    hasUpdates: result.hasUpdates,
    behind: result.behind,
    changelog: result.changelog,
    hasGit: result.state !== "no-git",
    error: result.error,
  };
}

function packageJsonChanged(before: string, after: string): boolean {
  return before !== after;
}

export async function updateManagedPackage(
  input: UpdateRequest,
): Promise<Record<string, any>> {
  const installCmd = getInstallCommand();

  // 检查是 npm 包还是 git 包
  const isNpmPackage = isNpmManagedName(input.name);
  const npmPackagePath = path.join(
    process.cwd(),
    "node_modules",
    input.name,
    "package.json",
  );

  if (isNpmPackage && fs.existsSync(npmPackagePath)) {
    // Bun 包更新
    const updateArgs = installCmd.args.map((arg) =>
      arg === "install" ? "update" : arg,
    );
    const update = await runCommand(
      installCmd.cmd,
      [...updateArgs, input.name],
      process.cwd(),
    );
    if (update.code !== 0) {
      throw new Error(`bun update 失败: ${update.stderr || update.stdout}`);
    }
    return {
      ok: true,
      restartRequired: true,
      packageJsonChanged: false,
      reinstallOutput: update.stdout || update.stderr,
    };
  }

  // Git 包更新
  const dir = resolveManagedDir(input.target, input.name);

  const before = await runCommand("git", ["show", "HEAD:package.json"], dir);

  const pull = await runCommand("git", ["pull"], dir);
  if (pull.code !== 0) {
    throw new Error(`git pull 失败: ${pull.stderr || pull.stdout}`);
  }

  const after = await runCommand("git", ["show", "HEAD:package.json"], dir);
  const changed = packageJsonChanged(before.stdout, after.stdout);

  let reinstallOutput = "";
  if (changed) {
    const install = await runCommand(installCmd.cmd, installCmd.args, dir);
    if (install.code !== 0) {
      throw new Error(`依赖安装失败: ${install.stderr || install.stdout}`);
    }
    reinstallOutput = install.stdout || install.stderr;
  }

  managedPackageUpdateCache.delete(
    makeManagedUpdateCacheKey(input.target, input.name),
  );

  return {
    ok: true,
    restartRequired: true,
    packageJsonChanged: changed,
    reinstallOutput,
  };
}

export async function removeManagedPackage(
  input: RemoveRequest,
): Promise<Record<string, any>> {
  if (input.target === "plugin" && isSystemPluginName(input.name)) {
    throw new Error("系统插件不可卸载");
  }
  if (input.target === "service" && isSystemServiceName(input.name)) {
    throw new Error("系统服务不可卸载");
  }

  // construct full package name from short name
  const fullName = isNpmManagedName(input.name)
    ? input.name
    : fullPackageName(input.target, input.name);

  const installCmd = getInstallCommand();
  const removeArgs = installCmd.args.map((a) =>
    a === "add" ? "remove" : a,
  );

  const result = await runCommand(
    installCmd.cmd,
    [...removeArgs, fullName],
    process.cwd(),
  );

  if (result.code !== 0) {
    throw new Error(`bun remove 失败: ${result.stderr || result.stdout}`);
  }

  // clean up mioki.plugins list for plugins
  if (input.target === "plugin") {
    const pkgPath = ROOT_PACKAGE_PATH;
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const mioki = pkg.mioki ?? {};
        const plugins: string[] = Array.isArray(mioki.plugins) ? mioki.plugins : [];
        const shortName = fullName.replace(/^mioku-plugin-/, "");
        if (plugins.includes(shortName)) {
          pkg.mioki = { ...mioki, plugins: plugins.filter((p: string) => p !== shortName) };
          fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
        }
      } catch {
        // silently ignore package.json parse errors
      }
    }
  }

  managedPackageUpdateCache.delete(
    makeManagedUpdateCacheKey(input.target, input.name),
  );

  return {
    ok: true,
    restartRequired: true,
  };
}

export async function listManagedPackagesWithUpdates(
  target: ManagedTarget,
): Promise<Array<Record<string, any>>> {
  const packages = listManagedPackages(target);
  scheduleManagedUpdatesRefresh(target, packages);
  const refreshRunning = managedOverviewRefreshInFlight.has(target);

  return packages.map((item) => {
    const name = String(item.name || "");

    if (!item.hasGit) {
      return {
        ...item,
        updateState: "no-git",
        hasUpdates: false,
        behind: 0,
        updateError: "NOT_GIT_REPO",
        updateChecking: false,
      };
    }

    const cached = getCachedManagedUpdateInfo(target, name);
    if (cached) {
      return {
        ...item,
        updateState: cached.info.state,
        hasUpdates: cached.info.hasUpdates,
        behind: cached.info.behind,
        updateError: cached.info.error || "",
        updateChecking: refreshRunning && !isManagedUpdateCacheFresh(cached),
        updateCheckedAt: cached.checkedAt,
      };
    }

    return {
      ...item,
      updateState: "unknown",
      hasUpdates: false,
      behind: 0,
      updateError: "",
      updateChecking: true,
      updateCheckedAt: 0,
    };
  });
}

export async function getManagedPackageDetail(
  name: string,
  target: ManagedTarget,
): Promise<Record<string, any>> {
  // 插件名称前端传入时没有前缀，服务有前缀
  const isNpmPackage =
    isNpmManagedName(name) ||
    (target === "plugin" && /^[a-zA-Z0-9_-]+$/.test(name)) ||
    (target === "adapter" && /^[a-zA-Z0-9_-]+$/.test(name));

  // NPM 包从 npm registry 获取信息
  if (isNpmPackage || target === "service") {
    let fullName = name;
    if (target === "plugin" && !name.startsWith("mioku-plugin-")) {
      fullName = `mioku-plugin-${name}`;
    } else if (target === "service" && !name.startsWith("mioku-service-")) {
      fullName = `mioku-service-${name}`;
    } else if (target === "adapter" && !name.startsWith("mioku-adapter-")) {
      fullName = `mioku-adapter-${name}`;
    }

    // 从 npm registry 获取包信息
    const data = await fetchJson(
      `https://registry.npmjs.org/${encodeURIComponent(fullName)}`,
    );
    const latestVersion = String(data?.["dist-tags"]?.latest || "").trim();
    const latest = latestVersion ? data?.versions?.[latestVersion] || {} : {};

    // 服务优先使用 mioku-lab 的 GitHub 仓库地址，而不是 npm 包里的 repository 字段
    let repositoryUrl: string;
    if (target === "service") {
      const serviceName = fullName.startsWith("mioku-service-")
        ? fullName.replace(/^mioku-service-/, "")
        : fullName;
      repositoryUrl = `https://github.com/mioku-lab/mioku-service-${serviceName}`;
    } else {
      repositoryUrl = normalizeRepositoryUrl(latest?.repository);
    }

    // 获取本地已安装版本
    const localPkg =
      readPackageJson(path.join(NODE_MODULES_DIR, fullName)) || {};
    const localVersion = localPkg?.version || "0.0.0";
    const hasUpdates = latestVersion !== "" && localVersion !== latestVersion;

    const isSystemPlugin =
      target === "plugin" ? isSystemPluginName(name) : false;
    const isSystemService =
      target === "service" ? isSystemServiceName(name) : false;
    return {
      ok: true,
      data: {
        name: fullName.replace(/^(mioku-plugin-|mioku-service-)/, ""),
        target,
        path: path.join(NODE_MODULES_DIR, fullName),
        version: localVersion,
        latestVersion,
        description: String(
          latest?.description || data?.description || "",
        ).trim(),
        hasGit: false,
        isSystemPlugin,
        isSystemService,
        repository: repositoryUrl,
        originUrl: "",
        homepage: String(latest?.homepage || "").trim(),
        requiredServices: Array.isArray(latest?.mioku?.services)
          ? latest.mioku.services
          : [],
        missingServices: [],
        help: latest?.mioku?.help || null,
        readme: String(data?.readme || "").trim(),
        readmeFile: "README.md",
        updateState: "npm",
        hasUpdates,
        behind: hasUpdates ? 1 : 0,
        changelog: [],
        updateError: null,
      },
    };
  }

  // 非 npm 包使用原有的目录解析逻辑
  const dir = resolveManagedDir(target, name);
  const pkg = readPackageJson(dir) || {};
  const readme = readReadmeFile(dir);
  const originUrl = await getGitOriginUrl(dir);
  const repositoryFromPkg = getRepositoryFromPackage(pkg);
  const updateInfo = await getManagedPackageUpdateInfo(dir);
  setCachedManagedUpdateInfo(target, name, updateInfo);
  const requiredServices = Array.isArray(pkg?.mioku?.services)
    ? pkg.mioku.services
    : [];
  const missingServices = checkDependentServices(pkg);

  const isSystemPlugin = target === "plugin" ? isSystemPluginName(name) : false;
  const isSystemService = false;
  return {
    ok: true,
    data: {
      name,
      target,
      path: dir,
      version: pkg?.version || "0.0.0",
      description: pkg?.description || "",
      hasGit: fs.existsSync(path.join(dir, ".git")),
      isSystemPlugin,
      isSystemService,
      repository: repositoryFromPkg,
      originUrl,
      homepage: pkg?.homepage || "",
      requiredServices,
      missingServices,
      help: pkg?.mioku?.help || null,
      readme: readme?.content || "",
      readmeFile: readme?.fileName || "",
      updateState: updateInfo.state,
      hasUpdates: updateInfo.hasUpdates,
      behind: updateInfo.behind,
      changelog: updateInfo.changelog,
      updateError: updateInfo.error || "",
    },
  };
}

export async function changeManagedPackageRepo(
  name: string,
  target: ManagedTarget,
  repoUrl: string,
): Promise<Record<string, any>> {
  if (!isValidRepoUrl(repoUrl)) {
    throw new Error("仓库地址无效");
  }

  const dir = resolveManagedDir(target, name);
  const nextUrl = repoUrl.trim();
  const oldUrl = await getGitOriginUrl(dir);

  const setRemote = await runCommand(
    "git",
    ["remote", "set-url", "origin", nextUrl],
    dir,
  );
  if (setRemote.code !== 0) {
    throw new Error(
      `更新仓库地址失败: ${setRemote.stderr || setRemote.stdout}`,
    );
  }

  const packagePath = path.join(dir, "package.json");
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
      if (typeof pkg.repository === "string") {
        pkg.repository = nextUrl;
      } else if (pkg.repository && typeof pkg.repository === "object") {
        pkg.repository = { ...pkg.repository, url: nextUrl };
      } else {
        pkg.repository = nextUrl;
      }
      fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2), "utf-8");
    } catch {
      // ignore package.json update failure, git remote is the source of truth
    }
  }

  managedPackageUpdateCache.delete(makeManagedUpdateCacheKey(target, name));

  return {
    ok: true,
    oldUrl,
    newUrl: nextUrl,
  };
}

export async function updateAllManagedPackages(input: {
  target: ManagedTarget;
  packageManager?: PackageManager;
}): Promise<Record<string, any>> {
  const packages = listManagedPackages(input.target);
  const results: Array<Record<string, any>> = [];

  for (const item of packages) {
    const updateInfo = await getManagedPackageUpdateInfo(item.path);
    if (updateInfo.state === "no-git") {
      results.push({
        name: item.name,
        ok: false,
        skipped: true,
        reason: "NOT_GIT_REPO",
      });
      continue;
    }
    if (!updateInfo.hasUpdates) {
      results.push({
        name: item.name,
        ok: true,
        skipped: true,
        reason: updateInfo.state === "unknown" ? "CHECK_FAILED" : "UP_TO_DATE",
        error: updateInfo.error || "",
      });
      continue;
    }

    try {
      const updated = await updateManagedPackage({
        name: item.name,
        target: input.target,
        packageManager: input.packageManager,
      });
      results.push({
        name: item.name,
        ok: true,
        skipped: false,
        ...updated,
      });
    } catch (error: any) {
      results.push({
        name: item.name,
        ok: false,
        skipped: false,
        error: error?.message || "UPDATE_FAILED",
      });
    }
  }

  const updatedCount = results.filter(
    (item) => item.ok && !item.skipped,
  ).length;
  const failedCount = results.filter(
    (item) => !item.ok && !item.skipped,
  ).length;
  const skippedCount = results.filter((item) => item.skipped).length;

  return {
    ok: failedCount === 0,
    restartRequired: updatedCount > 0,
    updatedCount,
    failedCount,
    skippedCount,
    results,
  };
}

function pickWebUIDistAsset(
  assets: WebUIReleaseAsset[],
): WebUIReleaseAsset | null {
  const zipAssets = assets.filter((asset) =>
    /\.zip$/i.test(String(asset?.name || "")),
  );
  if (zipAssets.length === 0) return null;
  const distAsset = zipAssets.find((asset) =>
    /dist/i.test(String(asset?.name || "")),
  );
  return distAsset || zipAssets[0] || null;
}

async function fetchLatestWebUIUpdate(
  force = false,
): Promise<WebUIUpdateCheckResult> {
  const now = Date.now();
  if (
    !force &&
    webuiUpdateCache &&
    now - webuiUpdateCache.checkedAt < WEBUI_UPDATE_CACHE_TTL_MS
  ) {
    return webuiUpdateCache;
  }

  if (!force && webuiUpdateCheckInFlight) {
    return webuiUpdateCheckInFlight;
  }

  const job = (async () => {
    const currentVersion = readInstalledWebUIVersion();
    // mioku-webui repo is at mioku-lab/mioku-webui, used for GitHub API and dist download
    const repo = {
      owner: "mioku-lab",
      repo: "mioku-webui",
      fullName: "mioku-lab/mioku-webui",
    };

    const fallback: WebUIUpdateCheckResult = {
      currentVersion,
      latestVersion: currentVersion,
      releaseTag: "",
      releaseUrl: "",
      sourceRepo: repo.fullName,
      hasUpdates: false,
      canUpdate: false,
      assetName: "",
      assetUrl: "",
      checkedAt: Date.now(),
    };

    const res = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "mioku-webui-updater",
        },
      },
    );

    if (!res.ok) {
      return {
        ...fallback,
        error: `查询 GitHub Release 失败: HTTP_${res.status}`,
      };
    }

    const release = (await res.json().catch(() => ({}))) as any;
    const releaseTag = String(release?.tag_name || release?.name || "").trim();
    const latestVersion = normalizeVersionSpec(releaseTag || "unknown");
    const assets = Array.isArray(release?.assets)
      ? (release.assets as WebUIReleaseAsset[])
      : [];
    const distAsset = pickWebUIDistAsset(assets);
    const hasUpdates =
      latestVersion !== "unknown" &&
      isVersionNewer(latestVersion, currentVersion);

    return {
      currentVersion,
      latestVersion,
      releaseTag,
      releaseUrl: String(release?.html_url || ""),
      sourceRepo: repo.fullName,
      hasUpdates,
      canUpdate: hasUpdates && Boolean(distAsset?.browser_download_url),
      assetName: String(distAsset?.name || ""),
      assetUrl: String(distAsset?.browser_download_url || ""),
      checkedAt: Date.now(),
      error:
        hasUpdates && !distAsset
          ? "已检测到新版本，但 Release 没有可用 dist 压缩包"
          : "",
      proxiedAssetUrl: distAsset
        ? `https://gh-proxy.org/${encodeURIComponent(distAsset.browser_download_url)}`
        : "",
    };
  })();

  webuiUpdateCheckInFlight = job;
  try {
    const result = await job;
    webuiUpdateCache = result;
    return result;
  } finally {
    webuiUpdateCheckInFlight = null;
  }
}

export async function checkWebUIReleaseUpdate(
  force = false,
): Promise<Record<string, any>> {
  return fetchLatestWebUIUpdate(force);
}

async function fetchLatestMiokuUpdate(
  force = false,
): Promise<MiokuUpdateCheckResult> {
  const now = Date.now();
  if (
    !force &&
    miokuUpdateCache &&
    now - miokuUpdateCache.checkedAt < MIOKU_UPDATE_CACHE_TTL_MS
  ) {
    return miokuUpdateCache;
  }

  if (!force && miokuUpdateCheckInFlight) {
    return miokuUpdateCheckInFlight;
  }

  const job = (async () => {
    const cwd = process.cwd();
    const rootPkg = readRootPackageJson() || {};
    // example/package.json has no version field; read the installed mioku
    // package so the current version matches what the dashboard reports.
    const miokuPkg = readMiokuPackageJson();
    const currentVersion = normalizeVersionSpec(
      miokuPkg?.version || rootPkg?.version || "unknown",
    );

    // Get latest version from npm registry
    let latestVersion = currentVersion;
    try {
      const latestOutput = await runCommand(
        "bun",
        ["info", "mioku", "version"],
        cwd,
      );
      if (latestOutput.code === 0 && latestOutput.stdout.trim()) {
        latestVersion = normalizeVersionSpec(latestOutput.stdout.trim());
      }
    } catch {
      // ignore - keep currentVersion as fallback
    }

    const hasUpdates =
      latestVersion !== "unknown" &&
      currentVersion !== "unknown" &&
      isVersionNewer(latestVersion, currentVersion);

    return {
      currentVersion,
      latestVersion,
      sourceRepo: "mioku",
      currentBranch: "",
      targetRef: "",
      hasUpdates,
      behind: hasUpdates ? 1 : 0,
      changelog: [],
      checkedAt: Date.now(),
      error: "",
    };
  })();

  miokuUpdateCheckInFlight = job;
  try {
    const result = await job;
    miokuUpdateCache = result;
    return result;
  } finally {
    miokuUpdateCheckInFlight = null;
  }
}

export async function checkMiokuReleaseUpdate(
  force = false,
): Promise<Record<string, any>> {
  return fetchLatestMiokuUpdate(force);
}

export async function updateMiokuFromMain(): Promise<Record<string, any>> {
  const cwd = process.cwd();

  const beforePkg = readRootPackageJson();
  const beforeVersion = beforePkg?.version || "unknown";

  const update = await runCommand("bun", ["update", "mioku"], cwd);
  if (update.code !== 0) {
    throw new Error(`bun update mioku 失败: ${update.stderr || update.stdout}`);
  }

  const afterPkg = readRootPackageJson();
  const afterVersion = afterPkg?.version || beforeVersion;
  const changed = beforeVersion !== afterVersion;

  let reinstallOutput = "";
  if (changed) {
    const installCmd = getInstallCommand();
    const install = await runCommand(installCmd.cmd, installCmd.args, cwd);
    if (install.code !== 0) {
      throw new Error(`依赖安装失败: ${install.stderr || install.stdout}`);
    }
    reinstallOutput = install.stdout || install.stderr;
  }

  miokuUpdateCache = null;

  const next = await fetchLatestMiokuUpdate(true);
  return {
    ok: true,
    restartRequired: true,
    packageJsonChanged: changed,
    reinstallOutput,
    currentVersion: next.currentVersion,
    latestVersion: next.latestVersion,
    hasUpdates: next.hasUpdates,
  };
}

async function notifyOwnerWebUIDownloaded(version: string): Promise<void> {
  const miokuConfig = getMiokuConfig();
  const owners = miokuConfig?.owners || [];
  if (owners.length === 0) {
    return;
  }

  const bots = Array.from(connectedBots.values()).filter(Boolean);
  if (bots.length === 0) {
    return;
  }

  const settings = getWebUISettings();
  const auth = readJsonFile<{ token?: string }>(AUTH_PATH, {});
  const url = `http://${settings.host}:${settings.port}`;
  const token = auth?.token || "未设置";
  const message = [
    `🎉 WebUI v${version} 已就绪`,
    `地址: ${url}`,
    `鉴权密钥: ${token}`,
  ].join("\n");

  for (const ownerId of owners) {
    let notified = false;
    let lastError: unknown;
    for (const bot of bots) {
      if (!bot || (typeof bot.online === "boolean" && !bot.online)) {
        continue;
      }
      try {
        await bot.sendMessage({ type: "private", user_id: ownerId }, message);
        logger.info(
          `[webui] 已通过 ${bot.adapter ?? "bot"}/${bot.bot_id ?? "?"} 通知主人 ${ownerId} WebUI 已就绪`,
        );
        notified = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!notified) {
      const msg = formatSendError(lastError);
      logger.warn(`[webui] 通知主人 ${ownerId} 失败: ${msg}`);
    }
  }
}

export async function notifyOwnersAuthTokenRefreshed(
  token: string,
  expiresAt: number,
): Promise<void> {
  const owners = getMiokuConfig()?.owners || [];
  if (owners.length === 0) {
    return;
  }

  const MAX_ATTEMPTS = 24;
  const RETRY_INTERVAL_MS = 5000;

  let bots: any[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    bots = Array.from(connectedBots.values()).filter(Boolean);
    if (bots.length > 0) {
      break;
    }
    await sleep(RETRY_INTERVAL_MS);
  }

  if (bots.length === 0) {
    logger.warn("[webui] 密钥已刷新，但暂无在线 Bot，未能通知主人");
    return;
  }

  const settings = getWebUISettings();
  const url = `http://${settings.host}:${settings.port}`;
  const expireText = new Date(expiresAt).toLocaleString("zh-CN");
  const message = [
    "🔑 WebUI 鉴权密钥已更新",
    `地址: ${url}`,
    `新密钥: ${token}`,
    `有效期至: ${expireText}`,
  ].join("\n");

  for (const ownerId of owners) {
    let notified = false;
    let lastError: unknown;
    for (const bot of bots) {
      if (!bot || (typeof bot.online === "boolean" && !bot.online)) {
        continue;
      }
      try {
        await bot.sendMessage(
          { type: "private", user_id: ownerId },
          message,
        );
        logger.info(
          `[webui] 已通过 ${bot.adapter ?? "bot"}/${bot.bot_id ?? "?"} 通知主人 ${ownerId} 密钥更新`,
        );
        notified = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!notified) {
      const msg = formatSendError(lastError);
      logger.warn(
        `[webui] 通知主人 ${ownerId} 密钥更新失败: ${msg}`,
      );
    }
  }
}

/** 格式化 sendMessage 抛出的错误，方便排查（icqq 的 ApiRejection 带 code/message）。 */
function formatSendError(err: unknown): string {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const code = (err as { code?: number }).code;
    if (typeof code === "number" && Number.isFinite(code)) {
      return `${err.message} (code=${code})`;
    }
    return err.message;
  }
  return String(err);
}

export async function updateWebUIDistFromRelease(): Promise<
  Record<string, any>
> {
  if (webuiUpdatingInFlight) {
    return webuiUpdatingInFlight;
  }

  const task = (async () => {
    const check = await fetchLatestWebUIUpdate(true);
    if (!check.hasUpdates) {
      return {
        ok: true,
        updated: false,
        message: "当前已是最新版本",
        currentVersion: check.currentVersion,
        latestVersion: check.latestVersion,
      };
    }

    if (!check.assetUrl) {
      throw new Error(
        check.error || "没有找到可下载的 dist 压缩包，请检查 Release 资产",
      );
    }

    let lastLogTime = 0;
    const LOG_INTERVAL_MS = 2000;
    const downloadUrl = check.assetUrl;
    const tempDir = path.join(
      os.tmpdir(),
      `mioku-webui-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const zipPath = path.join(tempDir, check.assetName || "webui-dist.zip");
    const unpackDir = path.join(tempDir, "unpack");

    ensureDir(tempDir);
    ensureDir(unpackDir);

    let backupPath = "";
    try {
      logger.info(`[webui] 正在下载 WebUI dist...`);

      const res = await fetch(downloadUrl, {
        headers: { "User-Agent": "mioku-webui-updater/1.0" },
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        throw new Error(`下载失败: HTTP ${res.status}`);
      }

      let downloaded = 0;
      const handle = await fsp.open(zipPath, "w");
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          await handle.write(chunk);
          downloaded += chunk.byteLength;
          const now = Date.now();
          if (now - lastLogTime >= LOG_INTERVAL_MS) {
            logger.info(
              `[webui] 正在下载 WebUI dist... ${(downloaded / 1024 / 1024).toFixed(1)} MB 已下载`,
            );
            lastLogTime = now;
          }
        }
      } finally {
        await handle.close();
      }

      const zipStat = fs.statSync(zipPath);
      logger.info(
        `[webui] 下载完成 (${(zipStat.size / 1024 / 1024).toFixed(1)} MB)，正在解压...`,
      );

      const zip = new AdmZip(zipPath);
      zip.extractAllTo(unpackDir, true);

      const sourceDir = resolveDistSourceDir(unpackDir);
      if (!sourceDir) {
        throw new Error("压缩包内未找到可用的 WebUI dist 文件");
      }

      ensureDir(path.dirname(WEBUI_DIST));
      const targetExisted = fs.existsSync(WEBUI_DIST);
      if (targetExisted) {
        backupPath = `${WEBUI_DIST}.backup.${Date.now()}`;
        fs.renameSync(WEBUI_DIST, backupPath);
      }

      fs.mkdirSync(WEBUI_DIST, { recursive: true });
      fs.cpSync(sourceDir, WEBUI_DIST, { recursive: true, force: true });

      if (!hasUsableDistFiles(WEBUI_DIST)) {
        throw new Error("更新后的 dist 无效，缺少 index.html");
      }

      fs.writeFileSync(
        path.join(WEBUI_DIST, ".webui-version"),
        `${check.latestVersion}\n`,
        "utf-8",
      );

      if (backupPath && fs.existsSync(backupPath)) {
        fs.rmSync(backupPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (backupPath && fs.existsSync(backupPath)) {
        fs.rmSync(WEBUI_DIST, { recursive: true, force: true });
        fs.renameSync(backupPath, WEBUI_DIST);
      }
      throw error;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    webuiUpdateCache = {
      ...check,
      checkedAt: Date.now(),
      currentVersion: check.latestVersion,
      hasUpdates: false,
      canUpdate: false,
      error: "",
    };

    await notifyOwnerWebUIDownloaded(check.latestVersion);

    return {
      ok: true,
      updated: true,
      version: check.latestVersion,
      assetName: check.assetName,
      releaseUrl: check.releaseUrl,
      restartRequired: false,
    };
  })().finally(() => {
    webuiUpdatingInFlight = null;
  });

  webuiUpdatingInFlight = task;
  return task;
}

export async function ensureWebUIDist(): Promise<void> {
  // Skip if dist already exists and has usable files
  if (hasUsableDistFiles(WEBUI_DIST)) {
    return;
  }
  // Dist missing — trigger download
  logger.info("[webui] WebUI dist 未找到，正在下载...");
  await updateWebUIDistFromRelease();
}

function readPackageVersion(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "unknown";
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed?.version || "unknown";
  } catch {
    return "unknown";
  }
}

async function getSystemInformationSnapshot(): Promise<{
  diskUsagePercent: number;
  diskTotal: number;
  diskUsed: number;
  netRxPerSec: number;
  netTxPerSec: number;
}> {
  try {
    const [fsSize, netStats] = await Promise.all([
      systemInfo.fsSize().catch(() => [] as any[]),
      systemInfo.networkStats().catch(() => [] as any[]),
    ]);

    const disk = Array.isArray(fsSize) && fsSize.length > 0 ? fsSize[0] : null;
    const diskTotal = Number(disk?.size || 0);
    const diskUsed = Number(disk?.used || 0);
    const diskUsagePercent =
      diskTotal > 0
        ? Number(((diskUsed / diskTotal) * 100).toFixed(1))
        : Number(disk?.use || 0);

    const networkList = Array.isArray(netStats) ? netStats : [];
    const netRxPerSec = networkList.reduce(
      (acc, item) => acc + Number(item?.rx_sec || 0),
      0,
    );
    const netTxPerSec = networkList.reduce(
      (acc, item) => acc + Number(item?.tx_sec || 0),
      0,
    );

    return {
      diskUsagePercent: Number.isFinite(diskUsagePercent)
        ? diskUsagePercent
        : 0,
      diskTotal,
      diskUsed,
      netRxPerSec: Number.isFinite(netRxPerSec) ? netRxPerSec : 0,
      netTxPerSec: Number.isFinite(netTxPerSec) ? netTxPerSec : 0,
    };
  } catch {
    return {
      diskUsagePercent: 0,
      diskTotal: 0,
      diskUsed: 0,
      netRxPerSec: 0,
      netTxPerSec: 0,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.irq +
      cpu.times.idle;
  }

  return { idle, total };
}

async function getCpuUsagePercent(): Promise<number> {
  const start = sampleCpuTimes();
  await sleep(180);
  const end = sampleCpuTimes();
  const idleDelta = end.idle - start.idle;
  const totalDelta = end.total - start.total;
  if (totalDelta <= 0) return 0;
  return Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(1));
}

function toHttpBaseUrl(bot: { options?: { protocol?: string; host?: string; port?: number } }): string {
  const protocol = String(bot.options?.protocol || "ws");
  const httpProtocol = protocol === "wss" ? "https" : "http";
  const host = bot.options?.host || "127.0.0.1";
  const port = bot.options?.port || 3001;
  return `${httpProtocol}://${host}:${port}`;
}

async function fetchYiyan(): Promise<{ text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch("https://uapis.cn/api/v1/saying", {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`);
    }
    const data = (await res.json()) as { text?: string };
    return { text: data?.text || "愿每一次启动都带来新的灵感。" };
  } catch {
    return { text: "愿每一次启动都带来新的灵感。" };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeVersionSpec(input: string): string {
  if (!input || input === "unknown") return "unknown";
  const cleaned = input.trim().replace(/^[~^<>=\s]+/, "");
  const matched = cleaned.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return matched?.[0] || cleaned;
}

async function getBotDetails(bot: import("mioku").Bot): Promise<Record<string, any>> {
  const botAny = bot as unknown as {
    uin?: number | string;
    user_id?: number | string;
    name?: string;
    options?: { protocol?: string; host?: string; port?: number };
    app_version?: string;
  };
  const qq = String(botAny.uin ?? botAny.user_id ?? bot.bot_id);
  const base = {
    botId: bot.bot_id,
    qq,
    nickname: bot.nickname || botAny.name || "Unknown Bot",
    avatar: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=160`,
    online: bot.online,
    napcatVersion: botAny.app_version || "unknown",
    napcatApiBase: toHttpBaseUrl(botAny),
    groupCount: 0,
    friendCount: 0,
    onlineDurationMs: 0,
    statusText: "online",
  };

  try {
    const [status, versionInfo, groups, friends] = await Promise.all([
      bot.sendApi<{ stat?: { start_time?: number; online?: boolean }; online?: boolean }>("get_status").catch(() => null),
      bot.sendApi<{ app_version?: string }>("get_version_info").catch(() => null),
      bot.getGroupList().catch(() => []),
      bot.getFriendList().catch(() => []),
    ]);

    const stat = status?.stat || null;
    const startTs = Number(stat?.start_time || 0);
    const onlineDurationMs =
      startTs > 0 ? Math.max(0, Date.now() - startTs) : 0;
    const onlineFromStatus =
      typeof status?.online === "boolean" ? status.online : true;

    return {
      ...base,
      online: onlineFromStatus,
      napcatVersion: versionInfo?.app_version || base.napcatVersion,
      groupCount: Array.isArray(groups) ? groups.length : 0,
      friendCount: Array.isArray(friends) ? friends.length : 0,
      onlineDurationMs,
      statusText: onlineFromStatus ? "online" : "offline",
    };
  } catch (error: any) {
    return {
      ...base,
      online: false,
      statusText: "error",
      error: error?.message || "NAPCAT_API_ERROR",
    };
  }
}

export async function getSystemOverview(): Promise<Record<string, any>> {
  const rootPkg = readRootPackageJson();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || "unknown";
  const cpuSpeedMHz = cpus[0]?.speed || 0;
  const cpuCores = cpus.length;
  const cpuUsagePercent = await getCpuUsagePercent();

  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const memoryUsagePercent =
    totalMemory > 0 ? Number(((usedMemory / totalMemory) * 100).toFixed(1)) : 0;

  const processMemory = process.memoryUsage();
  const processMemoryPercent =
    totalMemory > 0
      ? Number(((processMemory.rss / totalMemory) * 100).toFixed(1))
      : 0;
  const siSnapshot = await getSystemInformationSnapshot();

  const botInstances = Array.from(connectedBots.values());
  const bots = await Promise.all(botInstances.map((bot) => getBotDetails(bot)));
  const selectedBot = bots[0] || null;

  return {
    uptimeSeconds: process.uptime(),
    bots,
    selectedBot,
    system: {
      cpuModel,
      cpuSpeedMHz,
      cpuCores,
      cpuUsagePercent,
      memoryTotal: totalMemory,
      memoryUsed: usedMemory,
      memoryFree: freeMemory,
      memoryUsagePercent,
      processMemoryRss: processMemory.rss,
      processMemoryHeapUsed: processMemory.heapUsed,
      processMemoryPercent,
      diskUsagePercent: siSnapshot.diskUsagePercent,
      diskTotal: siSnapshot.diskTotal,
      diskUsed: siSnapshot.diskUsed,
      networkRxPerSec: siSnapshot.netRxPerSec,
      networkTxPerSec: siSnapshot.netTxPerSec,
      osType: os.type(),
      osPlatform: os.platform(),
      osRelease: os.release(),
      osVersion: (() => {
        if (os.platform() === "darwin") {
          try {
            const result = require("child_process")
              .execSync("sw_vers -productVersion")
              .toString()
              .trim();
            if (result) return result;
          } catch {
            // ignore
          }
        }
        return typeof os.version === "function" ? os.version() : "unknown";
      })(),
      nodeVersion: process.version,
    },
    versions: {
      mioki: (() => {
        const miokiPkg = readMiokiPackageJson();
        if (miokiPkg?.version) return normalizeVersionSpec(miokiPkg.version);
        return normalizeVersionSpec(
          rootPkg?.dependencies?.mioki ||
            rootPkg?.devDependencies?.mioki ||
            "unknown",
        );
      })(),
      mioku: (() => {
        const miokuPkg = readMiokuPackageJson();
        if (miokuPkg?.version) return normalizeVersionSpec(miokuPkg.version);
        return rootPkg?.version || "unknown";
      })(),
      webui: readInstalledWebUIVersion(),
      webuiService: readPackageVersion(
        path.join(
          process.cwd(),
          "node_modules",
          "mioku-service-webui",
          "package.json",
        ),
      ),
    },
    plugins: listManagedPackages("plugin"),
    services: listManagedPackages("service"),
  };
}

export async function getSaying(): Promise<{ text: string }> {
  return fetchYiyan();
}

export function getChatConfig(fileName: string): any {
  const filePath = path.join(CHAT_CONFIG_DIR, fileName);
  return readJsonFile(filePath, {});
}

export function updateChatConfig(fileName: string, data: any): any {
  const filePath = path.join(CHAT_CONFIG_DIR, fileName);
  writeJsonFile(filePath, data);
  return data;
}

export function getAdapterConfigs(adapterName: string): any {
  const rootPkg = readRootPackageJson();
  const adapters = rootPkg?.mioku?.adapters ?? {};
  const safeName = String(adapterName || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  return adapters[safeName] ?? {};
}

export function updateAdapterConfig(adapterName: string, data: any): any {
  const safeName = String(adapterName || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeName) throw new Error("适配器名称无效");
  const rootPkg = readRootPackageJson();
  rootPkg.mioku = rootPkg.mioku ?? {};
  rootPkg.mioku.adapters = rootPkg.mioku.adapters ?? {};
  rootPkg.mioku.adapters[safeName] = data ?? {};
  writeRootPackageJson(rootPkg);
  return data;
}

export interface MiokuConfig {
  owners: number[];
  admins: number[];
  napcat: Array<{
    name: string;
    protocol: string;
    port: number;
    host: string;
    token: string;
  }>;
  plugins: string[];
  core: CoreSystemConfig;
}

export function getMiokuConfig(): MiokuConfig {
  const localConfig = readJsonFile<any>(LOCAL_CONFIG_PATH, null);
  const rootPkg = readRootPackageJson();

  const miokiConfig =
    localConfig && localConfig.mioki ? localConfig.mioki : rootPkg?.mioki || {};

  return {
    owners: Array.isArray(miokiConfig.owners) ? miokiConfig.owners : [],
    admins: Array.isArray(miokiConfig.admins) ? miokiConfig.admins : [],
    napcat: Array.isArray(miokiConfig.napcat) ? miokiConfig.napcat : [],
    plugins: Array.isArray(miokiConfig.plugins) ? miokiConfig.plugins : [],
    core: getCoreSystemConfig(),
  };
}

export function updateMiokuConfig(config: Partial<MiokuConfig>): MiokuConfig {
  const current = getMiokuConfig();
  const updated: MiokuConfig = {
    owners: Array.isArray(config.owners) ? config.owners : current.owners,
    admins: Array.isArray(config.admins) ? config.admins : current.admins,
    napcat: Array.isArray(config.napcat) ? config.napcat : current.napcat,
    plugins: Array.isArray(config.plugins) ? config.plugins : current.plugins,
    core: config.core ? updateCoreSystemConfig(config.core) : current.core,
  };

  const localConfig = readJsonFile<any>(LOCAL_CONFIG_PATH, { mioki: {} });
  localConfig.mioki = {
    ...localConfig.mioki,
    owners: updated.owners,
    admins: updated.admins,
    napcat: updated.napcat,
    plugins: updated.plugins,
  };
  writeJsonFile(LOCAL_CONFIG_PATH, localConfig);

  const rootPkg = readRootPackageJson();
  if (rootPkg.mioki) {
    rootPkg.mioki.owners = updated.owners;
    rootPkg.mioki.admins = updated.admins;
    rootPkg.mioki.napcat = updated.napcat;
    rootPkg.mioki.plugins = updated.plugins;
    writeRootPackageJson(rootPkg);
  }

  return updated;
}

export function getAvailablePlugins(): string[] {
  const modulesPath = NODE_MODULES_DIR;
  if (!fs.existsSync(modulesPath)) {
    // Fallback to config-based reading
    const rootPkg = readRootPackageJson();
    const miokiConfig = rootPkg?.mioki || {};
    return Array.isArray(miokiConfig.plugins) ? miokiConfig.plugins : [];
  }

  const plugins: string[] = [];
  const entries = fs.readdirSync(modulesPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("mioku-plugin-")) continue;
    const fullPath = path.join(modulesPath, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    plugins.push(entry.name.replace(/^mioku-plugin-/, ""));
  }
  return plugins.sort((a, b) => a.localeCompare(b));
}

export interface PluginStatusItem {
  name: string;
  enabled: boolean;
  system: boolean;
  description: string;
}

export function getPluginStatusList(): PluginStatusItem[] {
  const allPlugins = getAvailablePlugins();
  const miokuConfig = getMiokuConfig();
  const enabledPlugins = new Set(miokuConfig.plugins || []);

  return allPlugins.map((name) => {
    const fullPath = path.join(NODE_MODULES_DIR, `mioku-plugin-${name}`);
    const pkg = readPackageJson(fullPath);
    return {
      name,
      enabled: enabledPlugins.has(name),
      system: SYSTEM_PLUGIN_NAMES.has(name.toLowerCase()),
      description: pkg?.description ?? "",
    };
  });
}

export function togglePlugin(name: string, enabled: boolean): PluginStatusItem {
  const safeName = String(name || "").trim();
  if (!safeName) throw new Error("插件名称为空");

  const config = getMiokuConfig();
  const plugins = new Set(config.plugins || []);

  if (enabled) {
    plugins.add(safeName);
  } else {
    plugins.delete(safeName);
  }

  updateMiokuConfig({ ...config, plugins: Array.from(plugins) });

  return {
    name: safeName,
    enabled: plugins.has(safeName),
    system: SYSTEM_PLUGIN_NAMES.has(safeName.toLowerCase()),
    description: "",
  };
}
