import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";

const OFFICIAL_REGISTRY_PATH = path.join(
  process.cwd(),
  "official-registry.json",
);
const NPM_PACKAGE_URL = "https://registry.npmjs.org";
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

let cachedOfficialRegistry: OfficialRegistry | null = null;
let officialRegistryCachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

function isCacheFresh(): boolean {
  return Date.now() - officialRegistryCachedAt < CACHE_TTL_MS;
}

function readOfficialRegistry(force = false): OfficialRegistry {
  if (!force && cachedOfficialRegistry && isCacheFresh()) {
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

function isServicePackage(name: string): boolean {
  return name.startsWith("mioku-service-");
}

function inferTypeFromPackageName(name: string): "plugin" | "service" | null {
  if (name.startsWith("mioku-plugin-")) return "plugin";
  if (name.startsWith("mioku-service-")) return "service";
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

async function fetchNpmPackage(name: string): Promise<any> {
  return fetchJson(`${NPM_PACKAGE_URL}/${encodeURIComponent(name)}`);
}

function getServiceInstallPath(pkg: any, packageName: string): string {
  const mioku = pkg?.mioku;
  const serviceName = String(
    mioku?.serviceName || inferDisplayName(packageName, "service") || "",
  ).trim();
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

  app.get("/package/:name", async (c) => {
    const force = c.req.query("force") === "1";
    const packageName = String(c.req.param("name") || "").trim();
    if (!packageName) {
      return c.json({ ok: false, error: "PACKAGE_NAME_REQUIRED" }, 400);
    }

    try {
      const officialRegistry = readOfficialRegistry(force);
      const officialMaps = buildOfficialMaps(officialRegistry);
      const data = await fetchNpmPackage(packageName);
      const latestVersion = String(data?.["dist-tags"]?.latest || "").trim();
      const latest = latestVersion ? data?.versions?.[latestVersion] || {} : {};
      const type = inferTypeFromPackageName(packageName);
      if (!type) {
        return c.json({ ok: false, error: "UNSUPPORTED_PACKAGE" }, 400);
      }

      const keywords = normalizeKeywords(latest?.keywords);
      const officialEntry =
        type === "plugin"
          ? officialMaps.plugins.get(packageName)
          : officialMaps.services.get(packageName);
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
          requiredServices: Array.isArray(latest?.mioku?.services)
            ? latest.mioku.services
            : [],
          installTarget: isServicePackage(packageName) ? "service" : "plugin",
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
