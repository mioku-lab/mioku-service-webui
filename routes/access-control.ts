import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "mioki";
import { readJsonFile, writeJsonFile, NODE_MODULES_DIR } from "../utils";

const ACCESS_CONFIG_PATH = path.resolve(
  process.cwd(),
  "config/boot/access-control.json",
);

const DEFAULT_CONFIG = {
  version: 1,
  global: { plugins: {}, commands: {} },
  groups: {},
  users: {},
};

export function normalizeAccessConfig(input: any) {
  return {
    version: 1,
    global: {
      plugins: input?.global?.plugins ?? {},
      commands: input?.global?.commands ?? {},
    },
    groups: input?.groups ?? {},
    users: input?.users ?? {},
  };
}

type AccessItemKind = "plugin" | "command";

interface AccessItem {
  kind: AccessItemKind;
  plugin: string;
  id: string;
  label: string;
  desc?: string;
  match?: string;
  event?: string;
  fromHook: boolean;
}

function readAccessCatalog(): AccessItem[] {
  if (!fs.existsSync(NODE_MODULES_DIR)) return [];
  const entries = fs.readdirSync(NODE_MODULES_DIR, { withFileTypes: true });
  const items: AccessItem[] = [];

  for (const entry of entries) {
    if (!entry.name.startsWith("mioku-plugin-")) continue;
    const fullPath = path.join(NODE_MODULES_DIR, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;

    const pkgPath = path.join(fullPath, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg: any;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch {
      continue;
    }

    const name = entry.name.replace(/^mioku-plugin-/, "");
    const mioku = pkg.mioku || {};
    const help = mioku.help || { title: name, description: "", commands: [] };
    const hooks: Array<{ id: string; match?: string; event?: string; description?: string }> =
      mioku.accessHooks || [];
    const helpCommands: Array<any> = help.commands || [];

    items.push({
      kind: "plugin",
      plugin: name,
      id: name,
      label: help.title || name,
      desc: help.description,
      fromHook: false,
    });

    const seen = new Set<string>();
    for (const hook of hooks) {
      seen.add(hook.id);
      items.push({
        kind: "command",
        plugin: name,
        id: hook.id,
        label: hook.id,
        desc: hook.description,
        match: hook.match,
        event: hook.event,
        fromHook: true,
      });
    }
    for (const c of helpCommands) {
      const id = String(c.cmd || "").trim();
      if (!id || seen.has(id)) continue;
      items.push({
        kind: "command",
        plugin: name,
        id,
        label: id,
        desc: c.desc,
        fromHook: false,
      });
    }
  }

  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "plugin" ? -1 : 1;
    if (a.plugin !== b.plugin) return a.plugin.localeCompare(b.plugin);
    return a.id.localeCompare(b.id);
  });
}

function filterCatalog(items: AccessItem[], query?: string): AccessItem[] {
  if (!query) return items;
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    return (
      it.id.toLowerCase().includes(q) ||
      it.label.toLowerCase().includes(q) ||
      it.plugin.toLowerCase().includes(q) ||
      (it.desc || "").toLowerCase().includes(q)
    );
  });
}

export function createAccessControlRoutes() {
  const app = new Hono();

  app.get("/", (c) => {
    const data = readJsonFile(ACCESS_CONFIG_PATH, DEFAULT_CONFIG);
    return c.json({ ok: true, data: normalizeAccessConfig(data) });
  });

  app.put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ ok: false, error: "INVALID_BODY" }, 400);
    }
    const data = normalizeAccessConfig(body);
    writeJsonFile(ACCESS_CONFIG_PATH, data);
    logger.info(
      `[webui-action] access-control.update | groups=${Object.keys(data.groups).length} users=${Object.keys(data.users).length}`,
    );
    return c.json({ ok: true, data });
  });

  app.get("/catalog", (c) => {
    const q = c.req.query("q");
    const data = filterCatalog(readAccessCatalog(), q);
    return c.json({ ok: true, data });
  });

  return app;
}
