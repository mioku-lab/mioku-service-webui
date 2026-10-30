import AdmZip from "adm-zip";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { locateSkillRoots, type SkillLocation } from "mioku";
import { ensureDir, isValidRepoUrl, runCommand, TEMP_DIR } from "./utils";

const STAGING_ROOT = path.join(TEMP_DIR, "webui-skills");
const STAGING_TTL_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 2000;

export type SkillSourceKind = "git" | "file" | "archive" | "local";

export interface ResolvedSkillSource {
  kind: SkillSourceKind;
  /** git 仓库地址（kind=git） */
  gitUrl?: string;
  /** 分支 / tag（kind=git） */
  ref?: string;
  /** 集合仓库内的子路径 */
  subPath?: string;
  /** 直接下载地址（kind=file / archive） */
  url?: string;
  /** 本地目录（kind=local） */
  localDir?: string;
  /** 展示用 */
  display: string;
}

export interface SkillStaging {
  id: string;
  dir: string;
  display: string;
  createdAt: number;
}

const staging = new Map<string, SkillStaging>();

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pruneStaging(): void {
  const now = Date.now();
  for (const [id, item] of staging) {
    if (now - item.createdAt < STAGING_TTL_MS) continue;
    staging.delete(id);
    fs.rmSync(item.dir, { recursive: true, force: true });
  }
}

export function getStaging(id: string): SkillStaging | undefined {
  pruneStaging();
  return staging.get(id);
}

export function releaseStaging(id: string): void {
  const item = staging.get(id);
  if (!item) return;
  staging.delete(id);
  fs.rmSync(item.dir, { recursive: true, force: true });
}

function expandHome(input: string): string {
  const raw = String(input ?? "").trim();
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

/** 把用户粘进来的东西解析成可下载的来源 */
export function resolveSkillSource(
  input: string,
): ResolvedSkillSource | { error: string } {
  const raw = String(input ?? "").trim();
  if (!raw) return { error: "来源不能为空" };
  if (/\s/.test(raw)) return { error: "来源不能包含空白字符" };

  if (raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("./") || raw.startsWith("../")) {
    const dir = path.resolve(expandHome(raw));
    if (!fs.existsSync(dir)) return { error: `本地路径不存在：${dir}` };
    return { kind: "local", localDir: dir, display: dir };
  }

  if (!/^https?:\/\//.test(raw)) {
    // `owner/repo`、`owner/repo#ref`、`owner/repo/sub/path`
    const [repoPart, ref] = raw.split("#");
    const segments = repoPart.split("/").filter(Boolean);
    if (segments.length < 2) {
      return { error: "简写需要 `owner/repo`，或直接粘贴完整 URL" };
    }
    const [owner, repo, ...rest] = segments;
    return {
      kind: "git",
      gitUrl: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}`,
      ...(ref ? { ref } : {}),
      ...(rest.length > 0 ? { subPath: rest.join("/") } : {}),
      display: raw,
    };
  }

  if (!isValidRepoUrl(raw)) return { error: "不支持的 URL" };

  const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)\/(.*))?$/.exec(
    raw,
  );
  if (github) {
    const [, owner, repo, ref, rest] = github;
    const isBlob = raw.includes("/blob/");
    if (isBlob) {
      return { kind: "file", url: raw.replace("/blob/", "/raw/"), display: raw };
    }
    return {
      kind: "git",
      gitUrl: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}`,
      ...(ref ? { ref } : {}),
      ...(rest ? { subPath: rest.replace(/\/$/, "") } : {}),
      display: raw,
    };
  }

  if (/\.git$/.test(raw) || /^https?:\/\/(?:[^/]+)\/[^/]+\/[^/]+$/.test(raw)) {
    return { kind: "git", gitUrl: raw.replace(/\.git$/, ""), display: raw };
  }
  if (/\.zip$/i.test(raw)) return { kind: "archive", url: raw, display: raw };
  return { kind: "file", url: raw, display: raw };
}

async function runWithTimeout(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runCommand(command, args, cwd),
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        timer = setTimeout(
          () => resolve({ code: -1, stdout: "", stderr: `${command} 超时` }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function download(url: string, target: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "mioku-skills" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_ARCHIVE_BYTES) throw new Error("文件过大");
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error("文件过大");
    await fsp.writeFile(target, buffer);
  } finally {
    clearTimeout(timer);
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** zip-slip 防护：条目必须落在目标目录内，符号链接一律拒绝 */
function extractZip(zipPath: string, target: string): void {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > MAX_EXTRACTED_FILES) {
    throw new Error(`压缩包条目过多（${entries.length}）`);
  }
  for (const entry of entries) {
    const full = path.resolve(target, entry.entryName);
    if (!isInside(target, full)) throw new Error(`压缩包路径越界：${entry.entryName}`);
    const attr = entry.attr >>> 16;
    if ((attr & 0o170000) === 0o120000) {
      throw new Error(`压缩包包含符号链接：${entry.entryName}`);
    }
  }
  zip.extractAllTo(target, true);
}

export interface FetchResult {
  stagingId: string;
  /** 取件根目录（subPath 指向的子目录或仓库根） */
  dir: string;
  display: string;
}

/** 取件到 temp 下的 staging 目录，按 TTL 自动清理 */
export async function fetchSkillSource(
  source: ResolvedSkillSource,
): Promise<FetchResult | { error: string }> {
  pruneStaging();
  const id = randomId();
  const dir = path.join(STAGING_ROOT, id);
  ensureDir(dir);

  try {
    if (source.kind === "git") {
      const args = ["clone", "--depth", "1"];
      if (source.ref) args.push("--branch", source.ref);
      args.push(source.gitUrl!, dir);
      const result = await runWithTimeout("git", args, STAGING_ROOT, GIT_TIMEOUT_MS);
      if (result.code !== 0) {
        throw new Error(`git clone 失败：${result.stderr || result.stdout}`);
      }
      fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
      const target = source.subPath ? path.join(dir, source.subPath) : dir;
      if (!isInside(dir, target) || !fs.existsSync(target)) {
        throw new Error(`仓库里没有路径 ${source.subPath}`);
      }
      staging.set(id, { id, dir: target, display: source.display, createdAt: Date.now() });
      return { stagingId: id, dir: target, display: source.display };
    }

    if (source.kind === "local") {
      staging.set(id, {
        id,
        dir: source.localDir!,
        display: source.display,
        createdAt: Date.now(),
      });
      return { stagingId: id, dir: source.localDir!, display: source.display };
    }

    const fileName = source.kind === "archive" ? "archive.zip" : "SKILL.md";
    const downloadPath = path.join(dir, fileName);
    await download(source.url!, downloadPath);
    if (source.kind === "archive") {
      const extracted = path.join(dir, "extracted");
      ensureDir(extracted);
      extractZip(downloadPath, extracted);
      fs.rmSync(downloadPath, { force: true });
      staging.set(id, { id, dir: extracted, display: source.display, createdAt: Date.now() });
      return { stagingId: id, dir: extracted, display: source.display };
    }
    staging.set(id, { id, dir, display: source.display, createdAt: Date.now() });
    return { stagingId: id, dir, display: source.display };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { error: String(err instanceof Error ? err.message : err) };
  }
}

export interface ProbeResult {
  stagingId: string;
  display: string;
  candidates: Array<SkillLocation & { rel: string }>;
}

/** 取件并列出可安装的技能候选 */
export async function probeSkillSource(
  input: string,
): Promise<ProbeResult | { error: string }> {
  const resolved = resolveSkillSource(input);
  if ("error" in resolved) return resolved;

  const fetched = await fetchSkillSource(resolved);
  if ("error" in fetched) return fetched;

  const located = await locateSkillRoots(fetched.dir);
  if (located.length === 0) {
    releaseStaging(fetched.stagingId);
    return { error: "没找到 SKILL.md，确认这是技能仓库或技能目录" };
  }
  return {
    stagingId: fetched.stagingId,
    display: fetched.display,
    candidates: located.map((item) => ({
      ...item,
      rel: path.relative(fetched.dir, item.dir).split(path.sep).join("/") || ".",
    })),
  };
}
