import { Hono } from "hono";
import { logger } from "mioki";
import { getChatConfig, updateChatConfig } from "../system";
import { listStickerCatalog } from "../database";
import aiService from "mioku-service-ai";
import type { AIModelRole, AIProtocol, AIUsageRange } from "mioku";

const DEFAULT_MEMORY_GROUP_HISTORY_LIMIT = 300;
const DEFAULT_MEMORY_USER_HISTORY_LIMIT = 100;
const DEFAULT_TOPIC_WINDOW_HOURS = 5;
const DEFAULT_TOPIC_HISTORY_WINDOW_COUNT = 3;
const DEFAULT_EXPRESSION_LEARN_AFTER_MESSAGES = 100;
const DEFAULT_EXPRESSION_SAMPLE_SIZE = 8;
const usageRanges = new Set<AIUsageRange>(["today", "7d", "30d"]);
const protocols = new Set<AIProtocol>([
  "openai-chat",
  "openai-response",
  "anthropic",
  "gemini",
]);
const roles = new Set<AIModelRole>(["main", "working", "vision"]);

function getAIApi() {
  return aiService?.api as any;
}

function normalizePersonalizationConfig(input: any): any {
  const data =
    input && typeof input === "object" && !Array.isArray(input)
      ? { ...input }
      : {};

  const rawMemory =
    data.memory && typeof data.memory === "object" && !Array.isArray(data.memory)
      ? { ...data.memory }
      : {};

  delete rawMemory.maxIterations;
  delete rawMemory.timeoutMs;

  const groupHistoryLimit = Number(rawMemory.groupHistoryLimit);
  const userHistoryLimit = Number(rawMemory.userHistoryLimit);

  rawMemory.groupHistoryLimit =
    Number.isFinite(groupHistoryLimit) && groupHistoryLimit > 0
      ? Math.floor(groupHistoryLimit)
      : DEFAULT_MEMORY_GROUP_HISTORY_LIMIT;
  rawMemory.userHistoryLimit =
    Number.isFinite(userHistoryLimit) && userHistoryLimit > 0
      ? Math.floor(userHistoryLimit)
      : DEFAULT_MEMORY_USER_HISTORY_LIMIT;
  rawMemory.enabled =
    typeof rawMemory.enabled === "boolean" ? rawMemory.enabled : true;

  data.memory = rawMemory;

  const rawTopic =
    data.topic && typeof data.topic === "object" && !Array.isArray(data.topic)
      ? { ...data.topic }
      : {};

  const windowHours = Number(rawTopic.windowHours);
  const legacyTimeThresholdMs = Number(rawTopic.timeThresholdMs);
  const historyWindowCount = Number(rawTopic.historyWindowCount);

  rawTopic.enabled =
    typeof rawTopic.enabled === "boolean" ? rawTopic.enabled : true;
  rawTopic.windowHours =
    Number.isFinite(windowHours) && windowHours > 0
      ? Math.floor(windowHours)
      : Number.isFinite(legacyTimeThresholdMs) && legacyTimeThresholdMs > 0
        ? Math.max(1, Math.floor(legacyTimeThresholdMs / 3600_000))
        : DEFAULT_TOPIC_WINDOW_HOURS;
  rawTopic.historyWindowCount =
    Number.isFinite(historyWindowCount) && historyWindowCount > 0
      ? Math.floor(historyWindowCount)
      : DEFAULT_TOPIC_HISTORY_WINDOW_COUNT;

  delete rawTopic.messageThreshold;
  delete rawTopic.timeThresholdMs;
  delete rawTopic.maxTopicsPerSession;

  data.topic = rawTopic;

  const rawExpression =
    data.expression &&
    typeof data.expression === "object" &&
    !Array.isArray(data.expression)
      ? { ...data.expression }
      : {};

  const learnAfterMessages = Number(rawExpression.learnAfterMessages);
  const legacyMaxExpressions = Number(rawExpression.maxExpressions);
  const sampleSize = Number(rawExpression.sampleSize);

  rawExpression.enabled =
    typeof rawExpression.enabled === "boolean" ? rawExpression.enabled : true;
  rawExpression.learnAfterMessages =
    Number.isFinite(learnAfterMessages) && learnAfterMessages > 0
      ? Math.floor(learnAfterMessages)
      : Number.isFinite(legacyMaxExpressions) && legacyMaxExpressions > 0
        ? Math.floor(legacyMaxExpressions)
        : DEFAULT_EXPRESSION_LEARN_AFTER_MESSAGES;
  rawExpression.sampleSize =
    Number.isFinite(sampleSize) && sampleSize > 0
      ? Math.floor(sampleSize)
      : DEFAULT_EXPRESSION_SAMPLE_SIZE;
  delete rawExpression.maxExpressions;

  data.expression = rawExpression;

  const rawEmoji =
    data.emoji && typeof data.emoji === "object" && !Array.isArray(data.emoji)
      ? { ...data.emoji }
      : {};
  rawEmoji.enabled =
    typeof rawEmoji.enabled === "boolean" ? rawEmoji.enabled : true;
  rawEmoji.characters = Array.isArray(rawEmoji.characters)
    ? rawEmoji.characters
        .map(String)
        .map((value: string) => value.trim())
        .filter(Boolean)
    : [];
  rawEmoji.stickers = Array.isArray(rawEmoji.stickers)
    ? rawEmoji.stickers
        .map(String)
        .map((value: string) => value.trim())
        .filter(Boolean)
    : [];
  delete rawEmoji.useAISelection;
  data.emoji = rawEmoji;

  return data;
}

function sanitizeBaseForSave(body: any): any {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  delete next.apiUrl;
  delete next.apiKey;
  delete next.model;
  delete next.workingModel;
  delete next.multimodalWorkingModel;
  delete next.isMultimodal;
  return next;
}

export function createAIRoutes() {
  const app = new Hono();

  app.get("/base", (c) => {
    const data = getChatConfig("base.json") || {};
    const api = getAIApi();
    const rolesData = api?.getRoleBindings?.() ?? {};
    const models = api?.listModels?.() ?? [];
    const pickModelId = (full?: string) => {
      if (!full) return "";
      const idx = full.indexOf("/");
      return idx > 0 ? full.slice(idx + 1) : full;
    };
    const vision = models.find((item: any) => item.id === rolesData.vision);
    return c.json({
      ok: true,
      data: {
        ...data,
        model: pickModelId(rolesData.main) || data.model || "",
        workingModel: pickModelId(rolesData.working) || data.workingModel || "",
        multimodalWorkingModel:
          pickModelId(rolesData.vision) || data.multimodalWorkingModel || "",
        isMultimodal: vision?.capabilities?.includes?.("vision") ?? true,
        providersManaged: true,
      },
    });
  });

  app.put("/base", async (c) => {
    const body = sanitizeBaseForSave(await c.req.json());
    logger.info(`[webui-action] ai.base.update`);
    return c.json({ ok: true, data: updateChatConfig("base.json", body) });
  });

  app.get("/personalization", (c) => {
    const data = normalizePersonalizationConfig(
      getChatConfig("personalization.json"),
    );
    return c.json({ ok: true, data });
  });
  app.put("/personalization", async (c) => {
    const body = normalizePersonalizationConfig(await c.req.json());
    logger.info(`[webui-action] ai.personalization.update`);
    return c.json({
      ok: true,
      data: updateChatConfig("personalization.json", body),
    });
  });

  app.get("/settings", (c) =>
    c.json({ ok: true, data: getChatConfig("settings.json") }),
  );
  app.put("/settings", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] ai.settings.update`);
    return c.json({
      ok: true,
      data: updateChatConfig("settings.json", body),
    });
  });

  app.get("/providers", (c) => {
    const api = getAIApi();
    if (!api?.listProviders) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const providers = api.listProviders().map((item: any) => ({
      ...item,
      apiKey: item.apiKey ? "***" : "",
      hasApiKey: Boolean(item.apiKey),
    }));
    return c.json({ ok: true, data: providers });
  });

  app.post("/providers", async (c) => {
    const api = getAIApi();
    if (!api?.createProvider) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const body = await c.req.json();
    const protocol = String(body?.protocol || "openai-chat") as AIProtocol;
    if (!protocols.has(protocol)) {
      return c.json({ ok: false, error: "INVALID_PROTOCOL" }, 400);
    }
    logger.info(`[webui-action] ai.provider.create`, {
      name: body?.name,
      protocol,
    });
    const created = await api.createProvider({
      id: body?.id,
      name: body?.name,
      protocol,
      apiUrl: body?.apiUrl,
      apiKey: body?.apiKey,
      enabled: body?.enabled !== false,
      headers: body?.headers,
    });
    return c.json({
      ok: true,
      data: {
        ...created,
        apiKey: created.apiKey ? "***" : "",
        hasApiKey: Boolean(created.apiKey),
      },
    });
  });

  app.put("/providers/:id", async (c) => {
    const api = getAIApi();
    if (!api?.updateProvider) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const id = c.req.param("id");
    const body = await c.req.json();
    logger.info(`[webui-action] ai.provider.update`, { id });
    const patch: Record<string, unknown> = { ...body };
    if (patch.apiKey === "***" || patch.apiKey === "") delete patch.apiKey;
    if (patch.protocol && !protocols.has(patch.protocol as AIProtocol)) {
      return c.json({ ok: false, error: "INVALID_PROTOCOL" }, 400);
    }
    const updated = await api.updateProvider(id, patch);
    return c.json({
      ok: true,
      data: {
        ...updated,
        apiKey: updated.apiKey ? "***" : "",
        hasApiKey: Boolean(updated.apiKey),
      },
    });
  });

  app.delete("/providers/:id", (c) => {
    const api = getAIApi();
    if (!api?.removeProvider) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const id = c.req.param("id");
    logger.info(`[webui-action] ai.provider.remove`, { id });
    return c.json({ ok: Boolean(api.removeProvider(id)) });
  });

  app.post("/providers/:id/test", async (c) => {
    const api = getAIApi();
    if (!api?.testProvider) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const id = c.req.param("id");
    logger.info(`[webui-action] ai.provider.test`, { id });
    const result = await api.testProvider(id);
    return c.json({ ok: true, data: result });
  });

  app.post("/providers/:id/models/refresh", async (c) => {
    const api = getAIApi();
    if (!api?.refreshModels) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const id = c.req.param("id");
    logger.info(`[webui-action] ai.models.refresh`, { id });
    const models = await api.refreshModels(id);
    return c.json({ ok: true, data: models });
  });

  app.get("/models", (c) => {
    const api = getAIApi();
    if (!api?.listModels) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const providerId = c.req.query("providerId") || undefined;
    return c.json({ ok: true, data: api.listModels(providerId) });
  });

  app.post("/models", async (c) => {
    const api = getAIApi();
    if (!api?.registerCustomModel) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const body = await c.req.json();
    logger.info(`[webui-action] ai.model.create`, {
      providerId: body?.providerId,
      modelId: body?.modelId,
    });
    const model = api.registerCustomModel({
      providerId: body?.providerId,
      modelId: body?.modelId,
      name: body?.name,
      capabilities: body?.capabilities,
    });
    return c.json({ ok: true, data: model });
  });

  app.delete("/models/:id", (c) => {
    const api = getAIApi();
    if (!api?.removeCustomModel) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const id = decodeURIComponent(c.req.param("id"));
    logger.info(`[webui-action] ai.model.remove`, { id });
    return c.json({ ok: Boolean(api.removeCustomModel(id)) });
  });

  app.get("/roles", (c) => {
    const api = getAIApi();
    if (!api?.getRoleBindings) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    return c.json({ ok: true, data: api.getRoleBindings() });
  });

  app.put("/roles", async (c) => {
    const api = getAIApi();
    if (!api?.setRoleBinding) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    const body = await c.req.json();
    logger.info(`[webui-action] ai.roles.update`, body);
    for (const role of ["main", "working", "vision"] as AIModelRole[]) {
      if (!(role in (body || {}))) continue;
      const value = body[role];
      if (value === null || value === undefined || value === "") {
        api.setRoleBinding(role, undefined);
      } else {
        api.setRoleBinding(role, String(value));
      }
    }
    return c.json({ ok: true, data: api.getRoleBindings() });
  });

  app.get("/instances", (c) => {
    const api = getAIApi();
    if (api?.listInstances) {
      return c.json({ ok: true, data: api.listInstances() });
    }
    const names = api?.list?.() ?? [];
    return c.json({ ok: true, data: names.map((name: string) => ({ name })) });
  });

  app.post("/instances", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] ai.instance.create`, {
      name: body?.name,
      providerId: body?.providerId,
      modelId: body?.modelId,
    });
    const api = getAIApi();
    if (api?.createInstance && body?.providerId && body?.modelId) {
      await api.createInstance({
        name: body.name,
        providerId: body.providerId,
        modelId: body.modelId,
        role: roles.has(body.role) ? body.role : undefined,
      });
      return c.json({ ok: true, data: api.listInstances?.() ?? api.list?.() });
    }
    if (!api?.create) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }
    await api.create({
      name: body.name,
      apiUrl: body.apiUrl,
      apiKey: body.apiKey,
      modelType: body.modelType || "text",
      model: body.model,
    });
    return c.json({ ok: true, data: api.list() });
  });

  app.delete("/instances/:name", (c) => {
    const name = c.req.param("name");
    logger.info(`[webui-action] ai.instance.remove`, { name });
    const ok = getAIApi()?.remove?.(name);
    return c.json({ ok: Boolean(ok) });
  });

  app.post("/default/:name", (c) => {
    const name = c.req.param("name");
    logger.info(`[webui-action] ai.instance.set-default`, { name });
    const ok = getAIApi()?.setDefault?.(name);
    return c.json({ ok: Boolean(ok) });
  });

  app.get("/skills", (c) => {
    const api = getAIApi();
    const skills = api?.getAllSkills?.();
    const tools = api?.getAllTools?.();
    return c.json({
      ok: true,
      data: {
        skills: skills ? Array.from(skills.keys()) : [],
        tools: tools ? Array.from(tools.keys()) : [],
      },
    });
  });

  app.get("/stickers", (c) =>
    c.json({ ok: true, data: listStickerCatalog() }),
  );

  app.get("/usage", (c) => {
    const api = getAIApi();
    if (!api?.getUsageSummary) {
      return c.json({ ok: false, error: "AI_USAGE_UNAVAILABLE" }, 503);
    }

    const rawRange = c.req.query("range");
    const range: AIUsageRange =
      rawRange && usageRanges.has(rawRange as AIUsageRange)
        ? (rawRange as AIUsageRange)
        : "today";
    const rawBotId = c.req.query("botId");
    const botId =
      rawBotId && rawBotId !== "all" ? Number(rawBotId) : undefined;

    if (botId !== undefined && !Number.isFinite(botId)) {
      return c.json({ ok: false, error: "INVALID_BOT_ID" }, 400);
    }

    return c.json({
      ok: true,
      data: api.getUsageSummary({ range, botId }),
    });
  });

  return app;
}
