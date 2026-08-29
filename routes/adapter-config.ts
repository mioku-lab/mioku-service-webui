import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAdapterConfigPage } from "../config-page-loader";
import { getAdapterConfigs, updateAdapterConfig } from "../system";

function listAdaptersFromNodeModules(): string[] {
  const modulesPath = path.join(process.cwd(), "node_modules");
  if (!fs.existsSync(modulesPath)) return [];
  const adapters: string[] = [];
  const entries = fs.readdirSync(modulesPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("mioku-adapter-")) continue;
    const fullPath = path.join(modulesPath, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    adapters.push(entry.name.replace(/^mioku-adapter-/, ""));
  }
  return adapters.sort((a, b) => a.localeCompare(b));
}

export function createAdapterConfigRoutes() {
  const app = new Hono();

  app.get("/overview", (c) => {
    const adapters = listAdaptersFromNodeModules();
    const overview = adapters
      .map((name) => {
        const manifest = loadAdapterConfigPage(name);
        return {
          name,
          title: manifest?.title || name,
          description: manifest?.description,
          hasPage: manifest?.hasCustomPage || false,
        };
      })
      .filter((a) => a.hasPage);

    return c.json({ ok: true, data: overview });
  });

  app.get("/:name/page", (c) => {
    const name = c.req.param("name");
    const manifest = loadAdapterConfigPage(name);
    if (!manifest) {
      return c.json({ ok: true, data: null });
    }

    return c.json({
      ok: true,
      data: {
        plugin: manifest.plugin,
        title: manifest.title,
        description: manifest.description,
        markdown: manifest.markdown,
        fields: manifest.fields,
        hasCustomPage: manifest.hasCustomPage,
        configs: {
          [name]: getAdapterConfigs(name),
        },
      },
    });
  });

  app.get("/:name", (c) => {
    const name = c.req.param("name");
    return c.json({ ok: true, data: getAdapterConfigs(name) });
  });

  app.put("/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    const data = updateAdapterConfig(name, body);
    return c.json({ ok: true, data });
  });

  return app;
}
