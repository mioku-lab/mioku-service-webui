import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";

const OFFICIAL_REGISTRY_URL = "https://raw.githubusercontent.com/mioku-lab/mioku/main/official-registry.json";
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
  adapters?: Record<string, OfficialPluginEntry>;
}

let cachedOfficialRegistry: OfficialRegistry | null = null;
let officialRegistryCachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

function isCacheFresh(): boolean {
  return Date.now() - officialRegistryCachedAt < CACHE_TTL_MS;
}

async function readOfficialRegistry(force = false): Promise<OfficialRegistry> {
  if (!force && cachedOfficialRegistry && isCacheFresh()) {
    return cachedOfficialRegistry;
  }

  try {
    const res = await fetch(OFFICIAL_REGISTRY_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "mioku-store",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`);
    }
    const parsed = JSON.parse(await res.text()) as OfficialRegistry;
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
  adapters: Map<string, OfficialPluginEntry>;
} {
  const plugins = new Map<string, OfficialPluginEntry>();
  const services = new Map<string, OfficialServiceEntry>();
  const adapters = new Map<string, OfficialPluginEntry>();

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

  for (const [, entry] of Object.entries(registry.adapters || {})) {
    if (entry?.npm) {
      adapters.set(entry.npm, entry);
    }
  }

  return { plugins, services, adapters };
}

function inferTypeFromPackageName(name: string): "plugin" | "service" | "adapter" | null {
  if (name.startsWith("mioku-plugin-")) return "plugin";
  if (name.startsWith("mioku-service-")) return "service";
  if (name.startsWith("mioku-adapter-")) return "adapter";
  return null;
}

function inferDisplayName(packageName: string, type: "plugin" | "service" | "adapter"): string {
  const prefix =
    type === "plugin" ? "mioku-plugin-" : type === "service" ? "mioku-service-" : "mioku-adapter-";
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
      const registry = await readOfficialRegistry(force);
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
      const officialRegistry = await readOfficialRegistry(force);
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
          : type === "service"
            ? officialMaps.services.get(packageName)
            : officialMaps.adapters.get(packageName);
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
          installTarget: type,
          installPath:
            type === "plugin"
              ? `plugins/${inferDisplayName(packageName, "plugin")}`
              : type === "service"
                ? getServiceInstallPath(latest, packageName)
                : `adapters/${inferDisplayName(packageName, "adapter")}`,
        },
      });
    } catch (error: any) {
      return c.json({ ok: false, error: error?.message || "FETCH_FAILED" }, 502);
    }
  });

  return app;
}
