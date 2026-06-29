import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  deleteMessagesByRange,
  exportData,
  getPluginConfigs,
  getStats,
  importDataFromJson,
  listMemeTree,
  listTables,
  queryMessages,
  savePluginConfig,
  updateMessage,
} from "../database";
import { CHAT_DATA_DIR } from "../utils";
import { loadPluginConfigPage, loadServiceConfigPage } from "../config-page-loader";
import { getDatasource } from "../datasources";
import {
  getServiceConfigs,
  updateServiceConfig,
} from "mioku";

export function createDBRoutes() {
  const app = new Hono();

  app.get("/tables", (c) =>
    c.json({ ok: true, data: listTables() }),
  );

  app.get("/messages", (c) => {
    const q = c.req.query();
    const data = queryMessages({
      table: q.table,
      keyword: q.keyword,
      userId: q.userId,
      sessionId: q.sessionId,
      startTime: q.startTime ? Number(q.startTime) : undefined,
      endTime: q.endTime ? Number(q.endTime) : undefined,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 20,
    });
    return c.json({ ok: true, data });
  });

  app.get("/stats", (c) =>
    c.json({ ok: true, data: getStats() }),
  );

  app.put("/message", async (c) => {
    const body = await c.req.json();
    return c.json({ ok: true, data: updateMessage(body) });
  });

  app.post("/cleanup", async (c) => {
    const body = await c.req.json();
    return c.json({ ok: true, data: deleteMessagesByRange(body) });
  });

  app.get("/export", (c) => {
    const format = (c.req.query("format") === "csv" ? "csv" : "json") as
      | "json"
      | "csv";
    const result = exportData(format);
    return c.json({ ok: true, data: result });
  });

  app.post("/import", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return c.json({ ok: false, error: "FILE_REQUIRED" }, 400);
    }
    const result = importDataFromJson(file as any);
    return c.json({ ok: true, data: result });
  });

  return app;
}

export function createPluginConfigRoutes() {
  const app = new Hono();

  app.get("/overview", (c) => {
    const modulesPath = path.join(process.cwd(), "node_modules");
    if (!fs.existsSync(modulesPath)) {
      return c.json({ ok: true, data: [] });
    }

    const plugins: string[] = [];
    const entries = fs.readdirSync(modulesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("mioku-plugin-")) {
        plugins.push(entry.name.replace(/^mioku-plugin-/, ""));
      }
    }

    const overview = plugins
      .map((name) => {
        const configDir = path.join(process.cwd(), "config", name);
        const manifest = loadPluginConfigPage(name);
        const existingConfigFiles =
          fs.existsSync(configDir)
            ? fs
                .readdirSync(configDir)
                .filter((f) => f.endsWith(".json"))
                .map((f) => f.replace(".json", ""))
            : [];
        const declaredConfigFiles = manifest
          ? Array.from(
              new Set(
                (manifest.fields || [])
                  .map((field) => String(field.key || ""))
                  .filter((key) => key.includes("."))
                  .map((key) => key.split(".")[0]),
              ),
            )
          : [];
        const configFiles = Array.from(
          new Set([...existingConfigFiles, ...declaredConfigFiles]),
        );

        return {
          name,
          title: manifest?.title || name,
          description: manifest?.description,
          hasPage: manifest?.hasCustomPage || false,
          configFiles,
        };
      })
      .filter((p) => p.hasPage);

    return c.json({ ok: true, data: overview });
  });

  app.get("/:name/page", (c) => {
    const name = c.req.param("name");
    const manifest = loadPluginConfigPage(name);
    const configs = getPluginConfigs(name);

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
        configs,
      },
    });
  });

  app.get("/datasources/:source", async (c) => {
    const source = c.req.param("source");
    const q = c.req.query("q") || undefined;
    const limitText = c.req.query("limit");
    const limit = limitText ? Number(limitText) : undefined;
    const options = await getDatasource(source, {
      q,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return c.json({ ok: true, data: options });
  });

  app.get("/:name", (c) => {
    const name = c.req.param("name");
    return c.json({ ok: true, data: getPluginConfigs(name) });
  });

  app.put("/:name/:config", async (c) => {
    const pluginName = c.req.param("name");
    const configName = c.req.param("config");
    const body = await c.req.json();
    savePluginConfig(pluginName, configName, body);
    return c.json({ ok: true });
  });

  return app;
}

export function createMemeRoutes() {
  const app = new Hono();

  const memeRoot = path.resolve(CHAT_DATA_DIR, "meme");
  const isInsideMeme = (target: string): boolean => {
    const resolved = path.resolve(target);
    return resolved === memeRoot || resolved.startsWith(`${memeRoot}${path.sep}`);
  };
  const isSafeSegment = (value: string): boolean =>
    Boolean(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== "..";

  app.get("/tree", (c) =>
    c.json({ ok: true, data: listMemeTree() }),
  );

  app.post("/upload", async (c) => {
    const form = await c.req.formData();
    const character = String(form.get("character") || "unknown");
    const emotion = String(form.get("emotion") || "default");
    const file = form.get("file") as File | null;
    if (!file) {
      return c.json({ ok: false, error: "FILE_REQUIRED" }, 400);
    }

    const fileName = file.name || `upload-${Date.now()}.png`;
    if (
      !isSafeSegment(character) ||
      !isSafeSegment(emotion) ||
      !isSafeSegment(fileName)
    ) {
      return c.json({ ok: false, error: "INVALID_NAME" }, 400);
    }

    const dir = path.join(memeRoot, character, emotion);
    const filePath = path.join(dir, fileName);
    if (!isInsideMeme(filePath)) {
      return c.json({ ok: false, error: "INVALID_PATH" }, 400);
    }

    fs.mkdirSync(dir, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    return c.json({ ok: true, path: path.relative(process.cwd(), filePath) });
  });

  app.delete("/", async (c) => {
    const body = await c.req.json();
    const filePath = path.resolve(process.cwd(), String(body.path || ""));
    if (!isInsideMeme(filePath)) {
      return c.json({ ok: false, error: "INVALID_PATH" }, 400);
    }
    if (!fs.existsSync(filePath)) {
      return c.json({ ok: false, error: "NOT_FOUND" }, 404);
    }
    fs.unlinkSync(filePath);
    return c.json({ ok: true });
  });

  return app;
}

export function createServiceConfigRoutes() {
  const app = new Hono();
  const SERVICE_CONFIG_ROOT = path.join(process.cwd(), "config", "service");

  app.get("/overview", (c) => {
    const modulesPath = path.join(process.cwd(), "node_modules");
    if (!fs.existsSync(modulesPath)) {
      return c.json({ ok: true, data: [] });
    }

    const services: string[] = [];
    const entries = fs.readdirSync(modulesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("mioku-service-")) {
        services.push(entry.name.replace(/^mioku-service-/, ""));
      }
    }

    const overview = services
      .map((name) => {
        const configDir = path.join(SERVICE_CONFIG_ROOT, name);
        const manifest = loadServiceConfigPage(name);
        const existingConfigFiles =
          fs.existsSync(configDir)
            ? fs
                .readdirSync(configDir)
                .filter((f) => f.endsWith(".json"))
                .map((f) => f.replace(".json", ""))
            : [];
        const declaredConfigFiles = manifest
          ? Array.from(
              new Set(
                (manifest.fields || [])
                  .map((field) => String(field.key || ""))
                  .filter((key) => key.includes("."))
                  .map((key) => key.split(".")[0]),
              ),
            )
          : [];
        const configFiles = Array.from(
          new Set([...existingConfigFiles, ...declaredConfigFiles]),
        );

        return {
          name,
          title: manifest?.title || name,
          description: manifest?.description,
          hasPage: manifest?.hasCustomPage || false,
          configFiles,
        };
      })
      .filter((p) => p.hasPage);

    return c.json({ ok: true, data: overview });
  });

  app.get("/:name/page", (c) => {
    const name = c.req.param("name");
    const manifest = loadServiceConfigPage(name);
    const configs = getServiceConfigs(name);

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
        configs,
      },
    });
  });

  app.get("/:name", (c) => {
    const name = c.req.param("name");
    return c.json({ ok: true, data: getServiceConfigs(name) });
  });

  app.put("/:name/:config", async (c) => {
    const serviceName = c.req.param("name");
    const configName = c.req.param("config");
    const body = await c.req.json();
    updateServiceConfig(serviceName, configName, body);
    return c.json({ ok: true });
  });

  return app;
}
