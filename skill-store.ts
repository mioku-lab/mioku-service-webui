import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  discoverSkills,
  parseSkillFile,
  resolveSkillRoots,
  SKILL_FILE_NAME,
  SKILL_NAME_PATTERN,
  type SkillDiagnostic,
  type SkillRoot,
} from "mioku";
import { getAgentConfig, updateAgentConfig } from "./system";
import {
  getStaging,
  resolveSkillSource,
  type SkillSourceKind,
} from "./skill-sources";
import { DATA_DIR, ensureDir, readJsonFile, writeJsonFile } from "./utils";

const REGISTRY_PATH = path.join(DATA_DIR, "webui", "skills.json");
const INSTALL_TMP_PREFIX = ".mioku-install-";

export interface SkillOrigin {
  kind: SkillSourceKind;
  /** 原始来源输入，更新时重新取件 */
  input: string;
  display: string;
  installedAt: number;
}

interface SkillsRegistry {
  version: 1;
  origins: Record<string, SkillOrigin>;
}

export interface SkillRootInfo extends SkillRoot {
  exists: boolean;
  skills: number;
}

export interface SkillListItem {
  name: string;
  description: string;
  rootId: string;
  rootLabel: string;
  rootPath: string;
  dir: string;
  path: string;
  resources: number;
  modelInvocable: boolean;
  userInvocable: boolean;
  enabled: boolean;
  canUninstall: boolean;
  origin?: SkillOrigin;
  diagnostics: SkillDiagnostic[];
}

export interface SkillDetail extends SkillListItem {
  content: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools: string[];
  resourceList: string[];
}

function readRegistry(): SkillsRegistry {
  const raw = readJsonFile<SkillsRegistry>(REGISTRY_PATH, {
    version: 1,
    origins: {},
  });
  return {
    version: 1,
    origins: raw && typeof raw.origins === "object" && raw.origins ? raw.origins : {},
  };
}

function writeRegistry(registry: SkillsRegistry): void {
  ensureDir(path.dirname(REGISTRY_PATH));
  writeJsonFile(REGISTRY_PATH, registry);
}

function registryKey(rootId: string, name: string): string {
  return `${rootId}/${name}`;
}

export function agentSkillRoots(): SkillRoot[] {
  const settings = getAgentConfig("settings.json") as {
    skills?: { extraRoots?: unknown };
  };
  const extraRoots = Array.isArray(settings?.skills?.extraRoots)
    ? settings.skills.extraRoots.map((item) => String(item ?? "")).filter(Boolean)
    : [];
  return resolveSkillRoots({ extraRoots });
}

export function readSkillsState(): { disabled: string[] } {
  const raw = getAgentConfig("skills.json") as { disabled?: unknown };
  const disabled = Array.isArray(raw?.disabled)
    ? raw.disabled.map((item) => String(item ?? "")).filter(Boolean)
    : [];
  return { disabled };
}

export function setSkillEnabled(name: string, enabled: boolean): { disabled: string[] } {
  const current = readSkillsState();
  const next = new Set(current.disabled);
  if (enabled) next.delete(name);
  else next.add(name);
  const value = { disabled: [...next].sort() };
  updateAgentConfig("skills.json", value);
  return value;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 清掉上次安装失败留下的临时目录 */
function cleanupStaleInstalls(root: SkillRoot): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(root.path);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60_000;
  for (const entry of entries) {
    if (!entry.startsWith(INSTALL_TMP_PREFIX)) continue;
    const full = path.join(root.path, entry);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // 忽略
    }
  }
}

export async function listAgentSkillRoots(): Promise<SkillRootInfo[]> {
  const roots = agentSkillRoots();
  const { skills } = await discoverSkills(roots);
  return roots.map((root) => ({
    ...root,
    exists: fs.existsSync(root.path),
    skills: skills.filter((skill) => skill.rootId === root.id).length,
  }));
}

export async function listAgentSkills(): Promise<{
  skills: SkillListItem[];
  diagnostics: SkillDiagnostic[];
  roots: SkillRootInfo[];
}> {
  const roots = agentSkillRoots();
  for (const root of roots) cleanupStaleInstalls(root);

  const { skills, diagnostics } = await discoverSkills(roots);
  const registry = readRegistry();
  const { disabled } = readSkillsState();
  const disabledSet = new Set(disabled);
  const rootById = new Map(roots.map((root) => [root.id, root]));

  return {
    skills: skills.map((skill) => {
      const root = rootById.get(skill.rootId);
      const origin = registry.origins[registryKey(skill.rootId, skill.name)];
      return {
        name: skill.name,
        description: skill.description,
        rootId: skill.rootId,
        rootLabel: root?.label ?? skill.rootId,
        rootPath: root?.path ?? "",
        dir: skill.dir,
        path: skill.path,
        resources: skill.resources.length,
        modelInvocable: skill.invoke.modelInvocable,
        userInvocable: skill.invoke.userInvocable,
        enabled: !disabledSet.has(skill.name),
        canUninstall: Boolean(root?.writable),
        ...(origin ? { origin } : {}),
        diagnostics: diagnostics.filter((item) => item.path === skill.path),
      };
    }),
    diagnostics,
    roots: roots.map((root) => ({
      ...root,
      exists: fs.existsSync(root.path),
      skills: skills.filter((skill) => skill.rootId === root.id).length,
    })),
  };
}

export async function readAgentSkill(
  rootId: string,
  name: string,
): Promise<SkillDetail | undefined> {
  const roots = agentSkillRoots();
  const { skills, diagnostics } = await discoverSkills(roots);
  const source = skills.find(
    (skill) => skill.name === name && (!rootId || skill.rootId === rootId),
  );
  if (!source) return undefined;

  const root = roots.find((item) => item.id === source.rootId);
  const registry = readRegistry();
  const origin = registry.origins[registryKey(source.rootId, source.name)];
  const disabledSet = new Set(readSkillsState().disabled);

  let raw: string;
  try {
    raw = await fsp.readFile(source.path, "utf-8");
  } catch {
    return undefined;
  }
  const parsed = parseSkillFile(source.path, raw);
  if (!parsed.skill) return undefined;

  return {
    name: source.name,
    description: source.description,
    rootId: source.rootId,
    rootLabel: root?.label ?? source.rootId,
    rootPath: root?.path ?? "",
    dir: source.dir,
    path: source.path,
    resources: source.resources.length,
    resourceList: source.resources,
    modelInvocable: source.invoke.modelInvocable,
    userInvocable: source.invoke.userInvocable,
    enabled: !disabledSet.has(source.name),
    canUninstall: Boolean(root?.writable),
    ...(origin ? { origin } : {}),
    diagnostics: [
      ...diagnostics.filter((item) => item.path === source.path),
      ...parsed.diagnostics,
    ],
    content: parsed.skill.content,
    allowedTools: parsed.skill.allowedTools,
    ...(parsed.skill.license ? { license: parsed.skill.license } : {}),
    ...(parsed.skill.compatibility
      ? { compatibility: parsed.skill.compatibility }
      : {}),
    ...(parsed.skill.metadata ? { metadata: parsed.skill.metadata } : {}),
  };
}

export interface InstallSkillInput {
  rootId: string;
  stagingId: string;
  /** staging 内的相对子目录，空表示根 */
  rel?: string;
  /** 覆盖安装名，默认用 frontmatter 的 name */
  name?: string;
  overwrite?: boolean;
  /** 原始来源输入，写进注册表供更新使用 */
  originInput?: string;
}

export interface InstallSkillResult {
  name: string;
  rootId: string;
  dir: string;
}

export async function installAgentSkill(
  input: InstallSkillInput,
): Promise<InstallSkillResult | { error: string }> {
  const root = agentSkillRoots().find((item) => item.id === input.rootId);
  if (!root) return { error: `未知的技能根：${input.rootId}` };
  if (!root.writable) return { error: `技能根 ${root.label} 不允许安装` };

  const staged = getStaging(input.stagingId);
  if (!staged) return { error: "取件结果已过期，请重新检测来源" };

  const sourceDir =
    input.rel && input.rel !== "."
      ? path.resolve(staged.dir, input.rel)
      : staged.dir;
  if (!isInside(staged.dir, sourceDir) && sourceDir !== staged.dir) {
    return { error: "候选路径越界" };
  }
  if (!fs.existsSync(sourceDir)) return { error: "候选目录不存在" };

  let raw: string;
  try {
    raw = await fsp.readFile(path.join(sourceDir, SKILL_FILE_NAME), "utf-8");
  } catch {
    return { error: "候选目录里没有 SKILL.md" };
  }
  const parsed = parseSkillFile(path.join(sourceDir, SKILL_FILE_NAME), raw);
  if (!parsed.skill) {
    return {
      error: `SKILL.md 校验不通过：${parsed.diagnostics[0]?.message ?? "未知原因"}`,
    };
  }

  const name = String(input.name ?? "").trim() || parsed.skill.name;
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { error: `技能名 "${name}" 不合法（小写字母、数字与单个连字符）` };
  }

  ensureDir(root.path);
  const target = path.join(root.path, name);
  if (fs.existsSync(target) && !input.overwrite) {
    return { error: `技能 ${name} 已存在于 ${root.label}，确认覆盖后再试` };
  }

  const stagingDir = path.join(root.path, `${INSTALL_TMP_PREFIX}${Date.now()}`);
  try {
    await fsp.cp(sourceDir, stagingDir, { recursive: true, dereference: true });
    if (fs.existsSync(target)) {
      await fsp.rm(target, { recursive: true, force: true });
    }
    await fsp.rename(stagingDir, target);
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return { error: `写入失败：${err instanceof Error ? err.message : err}` };
  }

  const registry = readRegistry();
  const originInput = String(input.originInput ?? staged.display);
  const resolved = resolveSkillSource(originInput);
  registry.origins[registryKey(root.id, name)] = {
    kind: "error" in resolved ? "local" : resolved.kind,
    input: originInput,
    display: staged.display,
    installedAt: Date.now(),
  };
  writeRegistry(registry);

  return { name, rootId: root.id, dir: target };
}

export async function uninstallAgentSkill(
  rootId: string,
  name: string,
): Promise<{ ok: true } | { error: string }> {
  if (!SKILL_NAME_PATTERN.test(name)) return { error: "技能名不合法" };
  const root = agentSkillRoots().find((item) => item.id === rootId);
  if (!root) return { error: `未知的技能根：${rootId}` };
  if (!root.writable) return { error: `技能根 ${root.label} 不允许卸载` };

  const target = path.join(root.path, name);
  if (!isInside(root.path, target)) return { error: "路径越界" };
  if (!fs.existsSync(path.join(target, SKILL_FILE_NAME))) {
    return { error: `在 ${root.label} 下找不到技能 ${name}` };
  }

  await fsp.rm(target, { recursive: true, force: true });
  const registry = readRegistry();
  delete registry.origins[registryKey(rootId, name)];
  writeRegistry(registry);
  setSkillEnabled(name, true);
  return { ok: true };
}

export function getSkillOrigin(rootId: string, name: string): SkillOrigin | undefined {
  return readRegistry().origins[registryKey(rootId, name)];
}

export function recordSkillOrigin(
  rootId: string,
  name: string,
  origin: SkillOrigin,
): void {
  const registry = readRegistry();
  registry.origins[registryKey(rootId, name)] = origin;
  writeRegistry(registry);
}
