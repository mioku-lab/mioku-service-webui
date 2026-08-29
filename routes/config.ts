import { Hono } from "hono";
import { logger } from "mioku";
import {
  getMiokuConfig,
  updateMiokuConfig,
  getAvailablePlugins,
  getPluginStatusList,
  togglePlugin,
  checkMiokuReleaseUpdate,
  updateMiokuFromMain,
} from "../system";

export function createConfigRoutes() {
  const app = new Hono();

  app.get("/mioku", (c) => {
    const data = getMiokuConfig();
    return c.json({ ok: true, data });
  });

  app.put("/mioku", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] config.mioku.update`, {
      owners: body?.owners?.length,
      admins: body?.admins?.length,
      napcat: body?.napcat?.length,
      plugins: body?.plugins?.length,
      coreConfigured: Boolean(body?.core),
    });
    const data = updateMiokuConfig(body);
    return c.json({ ok: true, data });
  });

  app.get("/mioku/update/check", async (c) => {
    const force = c.req.query("force") === "1";
    const data = await checkMiokuReleaseUpdate(force);
    return c.json({ ok: true, data });
  });

  app.post("/mioku/update/apply", async (c) => {
    logger.info(`[webui-action] config.mioku.update.apply`, {
      targetRef: "origin/unknown",
    });
    const data = await updateMiokuFromMain();
    return c.json({ ok: true, data });
  });

  app.get("/plugins/available", (c) => {
    const data = getAvailablePlugins();
    return c.json({ ok: true, data });
  });

  app.get("/plugins", (c) => {
    const data = getPluginStatusList();
    return c.json({ ok: true, data });
  });

  app.post("/plugins/toggle", async (c) => {
    const body = (await c.req.json()) as { name: string; enabled: boolean };
    const data = togglePlugin(body.name, body.enabled);
    logger.info(`[webui-action] config.plugins.toggle`, {
      name: body.name,
      enabled: body.enabled,
    });
    return c.json({ ok: true, data });
  });

  return app;
}
