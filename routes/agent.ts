import { Hono } from "hono";
import { logger } from "mioku";
import { getAgentConfig, updateAgentConfig } from "../system";
import aiService from "mioku-service-ai";

const PERMISSION_LEVELS = new Set([
  "read-only",
  "workspace-write",
  "auto",
  "full",
  "yolo",
]);

function normalizeIdList(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => Math.floor(Number(item)))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ),
  );
}

function sanitizeAccess(input: any): any {
  const access = input && typeof input === "object" ? input : {};
  return {
    allowAdmins: Boolean(access.allowAdmins),
    users: normalizeIdList(access.users),
  };
}

function sanitizeBaseForSave(body: any): any {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  delete next.persona;
  delete next.roleBindings;
  next.access = sanitizeAccess(next.access);
  next.workspaceDir = String(next.workspaceDir ?? "").trim();
  next.permissionLevel = PERMISSION_LEVELS.has(next.permissionLevel)
    ? next.permissionLevel
    : "workspace-write";
  next.model = String(next.model ?? "").trim();
  return next;
}

function sanitizeSettingsForSave(body: any): any {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  const positive = (value: unknown, fallback: number) => {
    const num = Math.floor(Number(value));
    return Number.isFinite(num) && num > 0 ? num : fallback;
  };
  delete next.temperature;
  delete next.enableMediaRecognition;
  next.maxIterations = positive(next.maxIterations, 500);
  next.maxContextTokens = positive(next.maxContextTokens, 524288);
  next.stream = next.stream !== false;
  next.enableMarkdownScreenshot = next.enableMarkdownScreenshot !== false;
  next.compaction = {
    enabled: next.compaction?.enabled !== false,
    keepRecentMessages: positive(next.compaction?.keepRecentMessages, 20),
  };
  next.webSearch = {
    enabled: next.webSearch?.enabled !== false,
    baseUrl: String(next.webSearch?.baseUrl ?? "").trim(),
    timeoutMs: positive(next.webSearch?.timeoutMs, 8000),
    defaultLimit: positive(next.webSearch?.defaultLimit, 5),
    maxLimit: positive(next.webSearch?.maxLimit, 8),
    maxSearchCount: positive(next.webSearch?.maxSearchCount, 50),
  };
  next.webFetch = {
    enabled: next.webFetch?.enabled !== false,
    timeoutMs: positive(next.webFetch?.timeoutMs, 15000),
    maxChars: positive(next.webFetch?.maxChars, 12000),
  };
  next.bash = {
    enabled: next.bash?.enabled !== false,
    timeoutMs: positive(next.bash?.timeoutMs, 120000),
    approvalTimeoutMs: positive(next.bash?.approvalTimeoutMs, 300000),
  };
  next.dataCollection = { enabled: next.dataCollection?.enabled !== false };
  next.debug = Boolean(next.debug);
  return next;
}

function getAIApi() {
  return aiService?.api as any;
}

export function createAgentRoutes() {
  const app = new Hono();

  app.get("/base", (c) =>
    c.json({ ok: true, data: getAgentConfig("base.json") }),
  );

  app.put("/base", async (c) => {
    const body = sanitizeBaseForSave(await c.req.json());
    logger.info(`[webui-action] agent.base.update`, {
      permissionLevel: body?.permissionLevel,
    });
    return c.json({ ok: true, data: updateAgentConfig("base.json", body) });
  });

  app.get("/settings", (c) =>
    c.json({ ok: true, data: getAgentConfig("settings.json") }),
  );

  app.put("/settings", async (c) => {
    const body = sanitizeSettingsForSave(await c.req.json());
    logger.info(`[webui-action] agent.settings.update`);
    return c.json({ ok: true, data: updateAgentConfig("settings.json", body) });
  });

  app.get("/status", (c) => {
    const api = getAIApi();
    const bindings = api?.getRoleBindings?.() ?? {};
    const base = getAgentConfig("base.json");
    return c.json({
      ok: true,
      data: {
        aiConfigured: Boolean(bindings.main),
        mainModel: bindings.main ?? "",
        permissionLevel: base?.permissionLevel ?? "workspace-write",
        workspaceDir: base?.workspaceDir ?? "",
      },
    });
  });

  return app;
}
