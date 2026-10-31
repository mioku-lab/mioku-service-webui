import { Hono } from "hono";
import { logger, servicesRegistry } from "mioku";
import type { McpServerInput, McpServiceApi } from "mioku-service-mcp";

/** 服务可能没装或没起来，统一走注册表按名查，缺失时返回 503 */
function mcp(): McpServiceApi | undefined {
  return servicesRegistry.mcp as McpServiceApi | undefined;
}

function unavailable(c: { json: (body: unknown, status: 503) => Response }): Response {
  return c.json({ ok: false, error: "MCP_SERVICE_UNAVAILABLE" }, 503);
}

function badRequest(
  c: { json: (body: unknown, status: 400) => Response },
  error: string,
): Response {
  return c.json({ ok: false, error }, 400);
}

function normalizeLimit(value: string | undefined, fallback: number): number {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(num, 500);
}

export function createMcpRoutes() {
  const app = new Hono();

  app.get("/overview", (c) => {
    const api = mcp();
    if (!api) return unavailable(c);
    const config = api.getConfig();
    return c.json({
      ok: true,
      data: {
        autoConnect: config.autoConnect,
        reconnectDelayMs: config.reconnectDelayMs,
        maxConcurrency: config.maxConcurrency,
        maxTools: config.maxTools,
        maxResultChars: config.maxResultChars,
        maxResultImages: config.maxResultImages,
        revision: api.revision(),
        toolCount: api.listTools().length,
        catalogOnlyCount: api.listAllTools().filter((tool) => tool.catalogOnly).length,
        servers: api.listServers(),
        configs: api.listServerConfigs(),
      },
    });
  });

  app.post("/servers", async (c) => {
    const api = mcp();
    if (!api) return unavailable(c);
    const body = (await c.req.json().catch(() => ({}))) as McpServerInput;
    const name = String(body?.name ?? "").trim().toLowerCase();
    if (!name) return badRequest(c, "请填写服务器名称");
    logger.info("[webui-action] mcp.server.upsert", { name });
    const result = await api.upsertServer({ ...body, name });
    if ("error" in result) return badRequest(c, result.error);
    return c.json({ ok: true, data: result });
  });

  app.delete("/servers/:name", async (c) => {
    const api = mcp();
    if (!api) return unavailable(c);
    const name = c.req.param("name");
    const removed = await api.removeServer(name);
    if (!removed) return badRequest(c, `服务器 "${name}" 不存在`);
    logger.info("[webui-action] mcp.server.remove", { name });
    return c.json({ ok: true, data: { name } });
  });

  app.put("/servers/:name/enabled", async (c) => {
    const api = mcp();
    if (!api) return unavailable(c);
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    const enabled = body?.enabled !== false;
    const result = await api.setServerEnabled(name, enabled);
    if ("error" in result) return badRequest(c, result.error);
    logger.info(`[webui-action] mcp.server.${enabled ? "enable" : "disable"}`, { name });
    return c.json({ ok: true, data: result });
  });

  for (const action of ["connect", "disconnect", "reconnect"] as const) {
    app.post(`/servers/:name/${action}`, async (c) => {
      const api = mcp();
      if (!api) return unavailable(c);
      const name = c.req.param("name");
      logger.info(`[webui-action] mcp.server.${action}`, { name });
      const result = await api[action](name);
      if ("error" in result) return badRequest(c, result.error);
      return c.json({ ok: true, data: result });
    });
  }

  app.get("/servers/:name/tools", (c) => {
    const api = mcp();
    if (!api) return unavailable(c);
    const name = c.req.param("name");
    if (!api.getServer(name)) return badRequest(c, `服务器 "${name}" 不存在`);
    const tools = api
      .listAllTools()
      .filter((tool) => tool.server === name)
      .map((tool) => ({
        publicName: tool.publicName,
        tool: tool.tool,
        description: tool.description,
        catalogOnly: tool.catalogOnly,
        parameters: tool.parameters,
      }));
    return c.json({ ok: true, data: tools });
  });

  app.post("/probe", async (c) => {
    const api = mcp();
    if (!api) return unavailable(c);
    const body = (await c.req.json().catch(() => ({}))) as McpServerInput;
    const name = String(body?.name ?? "").trim().toLowerCase();
    if (!name) return badRequest(c, "请填写服务器名称");
    logger.info("[webui-action] mcp.probe", { name });
    const result = await api.probe({ ...body, name });
    return c.json({ ok: true, data: result });
  });

  app.get("/logs", (c) => {
    const api = mcp();
    if (!api) return unavailable(c);
    const server = c.req.query("server") || undefined;
    const limit = normalizeLimit(c.req.query("limit"), 100);
    return c.json({ ok: true, data: api.recentLogs(server, limit) });
  });

  return app;
}
