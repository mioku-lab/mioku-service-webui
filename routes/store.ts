import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";

const OFFICIAL_REGISTRY_PATH = path.join(
  process.cwd(),
  "official-registry.json",
);
const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
const NPM_PACKAGE_URL = "https://registry.npmjs.org";
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_SEARCH_SIZE = 100;
const SERVICE_ROOT = "src/services";

interface OfficialPluginEntry {
  builtin?: boolean;
  npm?: string;
}

interface OfficialServiceEntry {
  builtin?: boolean;
  npm?: string;
}

interface OfficialRegistry {
  plugins?: Record<string, OfficialPluginEntry>;
  services?: Record<string, OfficialServiceEntry>;
}

interface NpmPackageLinks {
  npm?: string;
  homepage?: string;
  repository?: string;
  bugs?: string;
}

interface NpmSearchPackage {
  name: string;
  version?: string;
  description?: string;
  date?: string;
  keywords?: string[];
  links?: NpmPackageLinks;
}

interface NpmSearchObject {
  package: NpmSearchPackage;
  score?: Record<string, number>;
  searchScore?: number;
}

interface StoreItem {
  name: string;
  npm: string;
  type: "plugin" | "service";
  description: string;
  version: string;
  keywords: string[];
  tags: string[];
  official: boolean;
  builtin: boolean;
  repo: string;
  homepage: string;
  npmUrl: string;
  date: string;
  searchScore: number;
}

interface StoreListResponse {
  items: StoreItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  q: string;
  type: "plugin" | "service" | "all";
}

let cachedOfficialRegistry: OfficialRegistry | null = null;
let officialRegistryCachedAt = 0;
const npmSearchCache = new Map<string, { cachedAt: number; data: NpmSearchObject[] }>();
const npmPackageCache = new Map<string, { cachedAt: number; data: any }>();

function isCacheFresh(cachedAt: number): boolean {
  return Date.now() - cachedAt < CACHE_TTL_MS;
}

function readOfficialRegistry(force = false): OfficialRegistry {
  if (!force && cachedOfficialRegistry && isCacheFresh(officialRegistryCachedAt)) {
    return cachedOfficialRegistry;
  }

  try {
    const raw = fs.readFileSync(OFFICIAL_REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as OfficialRegistry;
    cachedOfficialRegistry = parsed;
    officialRegistryCachedAt = Date.now();
    return parsed;
  } catch (error: any) {
    throw new Error(`读取官方注册表失败: ${error?.message || error}`);
  }
}

function normalizeType(input: string | undefined): "plugin" | "service" | "all" {
  if (input === "plugin" || input === "service" || input === "all") {
    return input;
  }
  return "all";
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeLimit(input: string | undefined): number {
  const value = parsePositiveInt(input, DEFAULT_LIMIT);
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}

function normalizeOffset(input: string | undefined): number {
  return parsePositiveInt(input, 0);
}

function normalizeQuery(input: string | undefined): string {
  return String(input || "").trim();
}

function buildOfficialMaps(registry: OfficialRegistry): {
  plugins: Map<string, OfficialPluginEntry>;
  services: Map<string, OfficialServiceEntry>;
} {
  const plugins = new Map<string, OfficialPluginEntry>();
  const services = new Map<string, OfficialServiceEntry>();

  for (const [, entry] of Object.entries(registry.plugins || {})) {
    if (entry?.npm) {
      plugins.set(entry.npm, entry);
    }
  }

  for (const [, entry] of Object.entries(registry.services || {})) {
    if (entry?.npm) {
      services.set(entry.npm, entry);
    }
  }

  return { plugins, services };
}

function isPluginPackage(name: string): boolean {
  return name.startsWith("mioku-plugin-");
}

function isServicePackage(name: string): boolean {
  return name.startsWith("mioku-service-");
}

function inferTypeFromPackageName(name: string): "plugin" | "service" | null {
  if (isPluginPackage(name)) return "plugin";
  if (isServicePackage(name)) return "service";
  return null;
}

function inferDisplayName(packageName: string, type: "plugin" | "service"): string {
  const prefix = type === "plugin" ? "mioku-plugin-" : "mioku-service-";
  return packageName.startsWith(prefix)
    ? packageName.slice(prefix.length)
    : packageName;
}

function normalizeKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function extractTags(keywords: string[]): string[] {
  return keywords.filter((keyword) => keyword !== "mioku");
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

function scoreStoreItem(item: StoreItem, query: string): number {
  const q = query.toLowerCase();
  if (!q) return item.searchScore || 0;

  const fields = [
    item.name.toLowerCase(),
    item.npm.toLowerCase(),
    item.description.toLowerCase(),
    ...item.keywords.map((keyword) => keyword.toLowerCase()),
  ];

  let score = item.searchScore || 0;
  for (const field of fields) {
    if (field === q) score += 200;
    else if (field.startsWith(q)) score += 80;
    else if (field.includes(q)) score += 30;
  }
  if (item.official) score += 10;
  return score;
}

function compareStoreItems(a: StoreItem, b: StoreItem, query: string): number {
  if (a.official !== b.official) {
    return a.official ? -1 : 1;
  }

  const scoreDiff = scoreStoreItem(b, query) - scoreStoreItem(a, query);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const dateA = a.date ? new Date(a.date).getTime() : 0;
  const dateB = b.date ? new Date(b.date).getTime() : 0;
  if (dateA !== dateB) {
    return dateB - dateA;
  }

  return a.npm.localeCompare(b.npm);
}

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

async function searchNpmPackages(type: "plugin" | "service" | "all", query: string, force = false): Promise<NpmSearchObject[]> {
  const cacheKey = `${type}:${query}`;
  const cached = npmSearchCache.get(cacheKey);
  if (!force && cached && isCacheFresh(cached.cachedAt)) {
    return cached.data;
  }

  const terms: string[] = ["mioku"];
  if (query) terms.push(query);

  const url = new URL(NPM_SEARCH_URL);
  url.searchParams.set("text", terms.join(" "));
  url.searchParams.set("size", String(DEFAULT_SEARCH_SIZE));

  const data = await fetchJson(url.toString());
  const objects = Array.isArray(data?.objects) ? (data.objects as NpmSearchObject[]) : [];
  npmSearchCache.set(cacheKey, { cachedAt: Date.now(), data: objects });
  return objects;
}

async function fetchNpmPackage(name: string, force = false): Promise<any> {
  const cached = npmPackageCache.get(name);
  if (!force && cached && isCacheFresh(cached.cachedAt)) {
    return cached.data;
  }

  const data = await fetchJson(`${NPM_PACKAGE_URL}/${encodeURIComponent(name)}`);
  npmPackageCache.set(name, { cachedAt: Date.now(), data });
  return data;
}

function toStoreItem(
  pkg: NpmSearchPackage,
  officialMaps: ReturnType<typeof buildOfficialMaps>,
): StoreItem | null {
  const npm = String(pkg?.name || "").trim();
  const type = inferTypeFromPackageName(npm);
  if (!npm || !type) return null;

  const keywords = normalizeKeywords(pkg.keywords);
  const officialEntry = type === "plugin" ? officialMaps.plugins.get(npm) : officialMaps.services.get(npm);

  return {
    name: inferDisplayName(npm, type),
    npm,
    type,
    description: String(pkg.description || "").trim(),
    version: String(pkg.version || "").trim(),
    keywords,
    tags: extractTags(keywords),
    official: Boolean(officialEntry),
    builtin: Boolean(officialEntry?.builtin),
    repo: normalizeRepositoryUrl(pkg.links?.repository),
    homepage: String(pkg.links?.homepage || "").trim(),
    npmUrl: String(pkg.links?.npm || `https://www.npmjs.com/package/${npm}`),
    date: String(pkg.date || "").trim(),
    searchScore: Number(pkg ? 0 : 0),
  };
}

async function getStoreList(params: {
  type: "plugin" | "service" | "all";
  query: string;
  offset: number;
  limit: number;
  force?: boolean;
}): Promise<StoreListResponse> {
  const officialRegistry = readOfficialRegistry(params.force);
  const officialMaps = buildOfficialMaps(officialRegistry);
  const searchResults = await searchNpmPackages(params.type, params.query, params.force);

  const items = searchResults
    .map((entry) => {
      const item = toStoreItem(entry.package, officialMaps);
      if (!item) return null;
      return {
        ...item,
        searchScore: Number(entry.searchScore || entry.score?.final || 0),
      };
    })
    .filter((item): item is StoreItem => Boolean(item))
    .filter((item) => {
      if (params.type !== "all" && item.type !== params.type) {
        return false;
      }
      if (!params.query) return true;
      const q = params.query.toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        item.npm.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.keywords.some((keyword) => keyword.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => compareStoreItems(a, b, params.query));

  const total = items.length;
  const sliced = items.slice(params.offset, params.offset + params.limit);

  return {
    items: sliced,
    total,
    offset: params.offset,
    limit: params.limit,
    hasMore: params.offset + params.limit < total,
    q: params.query,
    type: params.type,
  };
}

function inferManagedTargetFromPackage(name: string): "plugin" | "service" {
  return isServicePackage(name) ? "service" : "plugin";
}

function getServiceInstallPath(pkg: any, packageName: string): string {
  const mioku = pkg?.mioku;
  const serviceName = String(mioku?.serviceName || inferDisplayName(packageName, "service") || "").trim();
  if (!serviceName) {
    return "";
  }
  return `${SERVICE_ROOT}/${serviceName}`;
}

export function createStoreRoutes() {
  const app = new Hono();

  app.get("/official", async (c) => {
    const force = c.req.query("force") === "1";
    try {
      const registry = readOfficialRegistry(force);
      return c.json({ ok: true, data: registry });
    } catch (error: any) {
      return c.json({ ok: false, error: error?.message || "FETCH_FAILED" }, 502);
    }
  });

  app.get("/search", async (c) => {
    const force = c.req.query("force") === "1";
    const query = normalizeQuery(c.req.query("q"));
    const type = normalizeType(c.req.query("type"));
    const offset = normalizeOffset(c.req.query("offset"));
    const limit = normalizeLimit(c.req.query("limit"));

    try {
      const result = await getStoreList({
        type,
        query,
        offset,
        limit,
        force,
      });
      return c.json({ ok: true, data: result });
    } catch (error: any) {
      return c.json({ ok: false, error: error?.message || "FETCH_FAILED" }, 502);
    }
  });

  app.get("/package/:name", async (c) => {
    const force = c.req.query("force") === "1";
    const packageName = String(c.req.param("name") || "").trim();
    if (!packageName) {
      return c.json({ ok: false, error: "PACKAGE_NAME_REQUIRED" }, 400);
    }

    try {
      const officialRegistry = readOfficialRegistry(force);
      const officialMaps = buildOfficialMaps(officialRegistry);
      const data = await fetchNpmPackage(packageName, force);
      const latestVersion = String(data?.["dist-tags"]?.latest || "").trim();
      const latest = latestVersion ? data?.versions?.[latestVersion] || {} : {};
      const type = inferTypeFromPackageName(packageName);
      if (!type) {
        return c.json({ ok: false, error: "UNSUPPORTED_PACKAGE" }, 400);
      }

      const keywords = normalizeKeywords(latest?.keywords);
      const officialEntry = type === "plugin" ? officialMaps.plugins.get(packageName) : officialMaps.services.get(packageName);
      const repositoryUrl = normalizeRepositoryUrl(latest?.repository);

      return c.json({
        ok: true,
        data: {
          name: inferDisplayName(packageName, type),
          npm: packageName,
          type,
          version: latestVersion,
          description: String(latest?.description || data?.description || "").trim(),
          keywords,
          tags: extractTags(keywords),
          official: Boolean(officialEntry),
          builtin: Boolean(officialEntry?.builtin),
          repo: repositoryUrl,
          homepage: String(latest?.homepage || "").trim(),
          npmUrl: `https://www.npmjs.com/package/${packageName}`,
          readme: String(data?.readme || "").trim(),
          license: String(latest?.license || "").trim(),
          dependencies: latest?.dependencies || {},
          requiredServices: Array.isArray(latest?.mioku?.services) ? latest.mioku.services : [],
          installTarget: inferManagedTargetFromPackage(packageName),
          installPath:
            type === "plugin"
              ? `plugins/${inferDisplayName(packageName, "plugin")}`
              : getServiceInstallPath(latest, packageName),
        },
      });
    } catch (error: any) {
      return c.json({ ok: false, error: error?.message || "FETCH_FAILED" }, 502);
    }
  });

  return app;
}
