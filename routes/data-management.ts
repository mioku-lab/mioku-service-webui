import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { unzipSync, zipSync } from "fflate";
import {
  BACKUP_DIR,
  CONFIG_DIR,
  DATA_DIR,
  LOGS_DIR,
  NODE_MODULES_DIR,
  TEMP_DIR,
  ensureDir,
  getInstallCommand,
  runCommand,
} from "../utils";
import { getWebUISettings } from "../system";

type CacheDeleteArea = "data" | "temp";
type BackupScope = "all" | "config-data";
type BackupRootName = "config" | "data" | "logs" | "node_modules" | "temp";

interface SizeResult {
  size: number;
  files: number;
  directories: number;
}

interface CacheEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  files: number;
  directories: number;
  mtimeMs: number;
  children?: CacheEntry[];
}

const cacheRoots: Record<CacheDeleteArea, string> = {
  data: DATA_DIR,
  temp: TEMP_DIR,
};

const backupRoots: Record<BackupRootName, string> = {
  config: CONFIG_DIR,
  data: DATA_DIR,
  logs: LOGS_DIR,
  node_modules: NODE_MODULES_DIR,
  temp: TEMP_DIR,
};

const configDataBackupRoots: BackupRootName[] = ["config", "data"];
const allBackupRoots: BackupRootName[] = [
  "config",
  "data",
  "logs",
  "node_modules",
  "temp",
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function timestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function isInside(parent: string, target: string): boolean {
  const root = path.resolve(parent);
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function resolveDirectChild(root: string, name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error("INVALID_NAME");
  }

  const fullPath = path.resolve(root, name);
  if (!isInside(root, fullPath) || path.dirname(fullPath) !== path.resolve(root)) {
    throw new Error("INVALID_PATH");
  }
  return fullPath;
}

function resolveCacheRelativePath(root: string, rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error("INVALID_PATH");
  }

  const fullPath = path.resolve(root, normalized);
  if (!isInside(root, fullPath) || fullPath === path.resolve(root)) {
    throw new Error("INVALID_PATH");
  }
  return fullPath;
}

function resolveBackupFile(name: string): string {
  if (path.basename(name) !== name || !name.endsWith(".zip")) {
    throw new Error("INVALID_BACKUP_NAME");
  }
  const fullPath = path.resolve(BACKUP_DIR, name);
  if (!isInside(BACKUP_DIR, fullPath)) {
    throw new Error("INVALID_BACKUP_PATH");
  }
  return fullPath;
}

async function pathSize(target: string): Promise<SizeResult> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(target);
  } catch {
    return { size: 0, files: 0, directories: 0 };
  }

  if (stat.isSymbolicLink()) {
    return { size: 0, files: 0, directories: 0 };
  }

  if (!stat.isDirectory()) {
    return { size: stat.size, files: 1, directories: 0 };
  }

  const entries = await fs.promises.readdir(target).catch(() => []);
  const results = await Promise.all(
    entries.map((entry) => pathSize(path.join(target, entry))),
  );
  return results.reduce<SizeResult>(
    (total, item) => ({
      size: total.size + item.size,
      files: total.files + item.files,
      directories: total.directories + item.directories,
    }),
    { size: 0, files: 0, directories: 1 },
  );
}

async function listEntries(
  root: string,
  directoriesOnly = false,
  depth = 2,
): Promise<CacheEntry[]> {
  if (!fs.existsSync(root)) return [];

  const dirents = await fs.promises.readdir(root, { withFileTypes: true });
  const entries = await Promise.all(
    dirents
      .filter((dirent) => !directoriesOnly || dirent.isDirectory())
      .map(async (dirent) => {
        const fullPath = path.join(root, dirent.name);
        const stat = await fs.promises.lstat(fullPath);
        const size = await pathSize(fullPath);
        const children =
          dirent.isDirectory() && depth > 0
            ? await listEntries(fullPath, false, depth - 1)
            : undefined;
        return {
          name: dirent.name,
          type: dirent.isDirectory() ? "directory" : "file",
          size: size.size,
          files: size.files,
          directories: size.directories,
          mtimeMs: stat.mtimeMs,
          children,
        } satisfies CacheEntry;
      }),
  );

  return entries.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

async function buildCacheOverview() {
  const [config, data, logs, nodeModules, temp] = await Promise.all([
    pathSize(CONFIG_DIR),
    pathSize(DATA_DIR),
    pathSize(LOGS_DIR),
    pathSize(NODE_MODULES_DIR),
    pathSize(TEMP_DIR),
  ]);

  const [configItems, dataItems, tempItems] = await Promise.all([
    listEntries(CONFIG_DIR),
    listEntries(DATA_DIR, true),
    listEntries(TEMP_DIR),
  ]);

  const logStat = fs.existsSync(LOGS_DIR) ? await fs.promises.stat(LOGS_DIR) : null;
  const nodeModulesStat = fs.existsSync(NODE_MODULES_DIR)
    ? await fs.promises.stat(NODE_MODULES_DIR)
    : null;

  return {
    generatedAt: Date.now(),
    totalSize: config.size + data.size + logs.size + nodeModules.size + temp.size,
    areas: {
      config: {
        path: "config",
        exists: fs.existsSync(CONFIG_DIR),
        size: config.size,
        files: config.files,
        directories: config.directories,
        items: configItems,
        deletable: false,
      },
      data: {
        path: "data",
        exists: fs.existsSync(DATA_DIR),
        size: data.size,
        files: data.files,
        directories: data.directories,
        items: dataItems,
        deletable: true,
      },
      logs: {
        path: "logs",
        exists: fs.existsSync(LOGS_DIR),
        size: logs.size,
        files: logs.files,
        directories: logs.directories,
        mtimeMs: logStat?.mtimeMs || 0,
      },
      nodeModules: {
        path: "node_modules",
        exists: fs.existsSync(NODE_MODULES_DIR),
        size: nodeModules.size,
        files: nodeModules.files,
        directories: nodeModules.directories,
        mtimeMs: nodeModulesStat?.mtimeMs || 0,
      },
      temp: {
        path: "temp",
        exists: fs.existsSync(TEMP_DIR),
        size: temp.size,
        files: temp.files,
        directories: temp.directories,
        items: tempItems,
        deletable: true,
      },
    },
  };
}

function removePath(target: string): void {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function clearPathContents(target: string): void {
  if (!fs.existsSync(target)) return;

  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) {
    fs.rmSync(target, { force: true });
    return;
  }

  for (const name of fs.readdirSync(target)) {
    removePath(path.join(target, name));
  }
}

function getBackupRootNames(scope: BackupScope): BackupRootName[] {
  return scope === "all" ? allBackupRoots : configDataBackupRoots;
}

function collectFiles(root: string, prefix: BackupRootName, output: Record<string, Uint8Array>): void {
  if (!fs.existsSync(root)) return;

  const walk = (current: string, relative: string) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        walk(path.join(current, name), path.posix.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) {
      output[path.posix.join(prefix, relative)] = fs.readFileSync(current);
    }
  };

  for (const name of fs.readdirSync(root)) {
    walk(path.join(root, name), name);
  }
}

function createBackup(prefix = "mioku-backup", scope: BackupScope = "config-data") {
  ensureDir(BACKUP_DIR);

  const files: Record<string, Uint8Array> = {};
  for (const rootName of getBackupRootNames(scope)) {
    collectFiles(backupRoots[rootName], rootName, files);
  }

  const scopeLabel = scope === "all" ? "all" : "config-data";
  const name = `${prefix}-${scopeLabel}-${timestamp()}.zip`;
  const filePath = path.join(BACKUP_DIR, name);
  const zipped = zipSync(files, { level: 6 });
  fs.writeFileSync(filePath, Buffer.from(zipped));
  const stat = fs.statSync(filePath);

  return {
    name,
    size: stat.size,
    createdAt: stat.birthtimeMs,
    modifiedAt: stat.mtimeMs,
    scope,
    downloadUrl: `/api/data-management/backups/${encodeURIComponent(name)}/download`,
  };
}

function listBackups() {
  ensureDir(BACKUP_DIR);
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => {
      const fullPath = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        size: stat.size,
        createdAt: stat.birthtimeMs,
        modifiedAt: stat.mtimeMs,
        scope: name.includes("-all-") ? "all" : "config-data",
        downloadUrl: `/api/data-management/backups/${encodeURIComponent(name)}/download`,
      };
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function normalizeArchiveName(rawName: string): string {
  const normalized = path.posix.normalize(rawName.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`备份包包含非法路径: ${rawName}`);
  }

  if (
    !allBackupRoots.some(
      (rootName) => normalized === rootName || normalized.startsWith(`${rootName}/`),
    )
  ) {
    throw new Error(`备份包只能包含 ${allBackupRoots.join("/、")}: ${rawName}`);
  }

  return normalized;
}

function detectRestoreScope(names: string[]): BackupScope {
  return names.some((name) =>
    ["logs/", "node_modules/", "temp/"].some((prefix) => name.startsWith(prefix)),
  )
    ? "all"
    : "config-data";
}

function restoreFromBuffer(buffer: Buffer) {
  const entries = unzipSync(buffer);
  const normalizedEntries = Object.entries(entries)
    .map(([name, content]) => ({
      name: normalizeArchiveName(name),
      content,
    }))
    .filter((entry) => !allBackupRoots.includes(entry.name as BackupRootName));

  const rollback = createBackup(
    "mioku-before-restore",
    detectRestoreScope(normalizedEntries.map((entry) => entry.name)),
  );
  let restoredFiles = 0;

  for (const entry of normalizedEntries) {
    if (entry.name.endsWith("/")) continue;

    const target = path.resolve(process.cwd(), entry.name);
    const insideAllowedRoot = allBackupRoots.some((rootName) =>
      isInside(backupRoots[rootName], target),
    );
    if (!insideAllowedRoot) {
      throw new Error(`备份包路径越界: ${entry.name}`);
    }

    ensureDir(path.dirname(target));
    fs.writeFileSync(target, Buffer.from(entry.content));
    restoredFiles += 1;
  }

  return {
    restoredFiles,
    rollback,
  };
}

async function cleanupLogs(mode: string, days?: number) {
  if (!fs.existsSync(LOGS_DIR)) {
    return { deleted: 0, kept: 0 };
  }

  const entries = await fs.promises.readdir(LOGS_DIR);
  let deleted = 0;
  let kept = 0;
  const cutoff = Date.now() - Number(days || 0) * 24 * 60 * 60 * 1000;

  for (const name of entries) {
    const fullPath = path.join(LOGS_DIR, name);
    const stat = await fs.promises.lstat(fullPath);
    const shouldDelete =
      mode === "all" ||
      (mode === "keep-days" && (days === 3 || days === 7) && stat.mtimeMs < cutoff);

    if (shouldDelete) {
      removePath(fullPath);
      deleted += 1;
    } else {
      kept += 1;
    }
  }

  return { deleted, kept };
}

export function createDataManagementRoutes() {
  const app = new Hono();

  app.get("/cache/overview", async (c) => {
    const data = await buildCacheOverview();
    return c.json({ ok: true, data });
  });

  app.post("/cache/delete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      area?: CacheDeleteArea;
      name?: string;
    };
    const area = body.area;
    if (area !== "data" && area !== "temp") {
      return c.json({ ok: false, error: "INVALID_AREA" }, 400);
    }

    const target = resolveDirectChild(cacheRoots[area], String(body.name || ""));
    clearPathContents(target);
    return c.json({ ok: true });
  });

  app.post("/cache/delete-selected", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      area?: CacheDeleteArea;
      paths?: string[];
    };
    const area = body.area;
    if (area !== "data" && area !== "temp") {
      return c.json({ ok: false, error: "INVALID_AREA" }, 400);
    }
    if (!Array.isArray(body.paths) || body.paths.length === 0) {
      return c.json({ ok: false, error: "PATHS_REQUIRED" }, 400);
    }

    const paths = Array.from(new Set(body.paths.map((item) => String(item || ""))));
    if (
      paths.some((item) => !path.posix.normalize(item.replace(/\\/g, "/")).includes("/"))
    ) {
      return c.json({ ok: false, error: "INVALID_PATH" }, 400);
    }

    const targets = paths
      .map((item) => resolveCacheRelativePath(cacheRoots[area], item))
      .sort((a, b) => b.length - a.length);
    for (const target of targets) {
      removePath(target);
    }

    return c.json({ ok: true, data: { deleted: targets.length } });
  });

  app.post("/logs/cleanup", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: "all" | "keep-days";
      days?: number;
    };
    if (body.mode !== "all" && body.mode !== "keep-days") {
      return c.json({ ok: false, error: "INVALID_MODE" }, 400);
    }
    if (body.mode === "keep-days" && body.days !== 3 && body.days !== 7) {
      return c.json({ ok: false, error: "INVALID_DAYS" }, 400);
    }

    const data = await cleanupLogs(body.mode, body.days);
    return c.json({ ok: true, data });
  });

  app.post("/node-modules/refresh", async (c) => {
    const settings = getWebUISettings();
    const command = getInstallCommand(settings.packageManager);
    const startedAt = Date.now();
    const result = await runCommand(command.cmd, command.args, process.cwd());
    const finishedAt = Date.now();

    return c.json({
      ok: result.code === 0,
      data: {
        packageManager: settings.packageManager,
        command: [command.cmd, ...command.args].join(" "),
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        startedAt,
        finishedAt,
      },
      error: result.code === 0 ? undefined : "INSTALL_FAILED",
    }, result.code === 0 ? 200 : 500);
  });

  app.get("/backups", (c) => {
    return c.json({ ok: true, data: listBackups() });
  });

  app.post("/backups", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: BackupScope;
    };
    const scope = body.scope === "all" ? "all" : "config-data";
    const data = createBackup("mioku-backup", scope);
    return c.json({ ok: true, data });
  });

  app.get("/backups/:name/download", async (c) => {
    const name = c.req.param("name");
    const filePath = resolveBackupFile(name);
    if (!fs.existsSync(filePath)) {
      return c.json({ ok: false, error: "NOT_FOUND" }, 404);
    }

    const file = await fs.promises.readFile(filePath);
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename="${path.basename(filePath)}"`);
    return c.body(file);
  });

  app.delete("/backups/:name", (c) => {
    const name = c.req.param("name");
    const filePath = resolveBackupFile(name);
    if (!fs.existsSync(filePath)) {
      return c.json({ ok: false, error: "NOT_FOUND" }, 404);
    }

    fs.unlinkSync(filePath);
    return c.json({ ok: true });
  });

  app.post("/restore/from-backup", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const filePath = resolveBackupFile(String(body.name || ""));
    if (!fs.existsSync(filePath)) {
      return c.json({ ok: false, error: "NOT_FOUND" }, 404);
    }

    const data = restoreFromBuffer(await fs.promises.readFile(filePath));
    return c.json({ ok: true, data });
  });

  app.post("/restore/upload", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return c.json({ ok: false, error: "FILE_REQUIRED" }, 400);
    }
    if (!file.name.endsWith(".zip")) {
      return c.json({ ok: false, error: "ZIP_REQUIRED" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const data = restoreFromBuffer(buffer);
    return c.json({ ok: true, data });
  });

  return app;
}
