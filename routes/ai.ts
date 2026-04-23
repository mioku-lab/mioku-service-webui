import { Hono } from "hono";
import { logger } from "mioki";
import { getChatConfig, updateChatConfig } from "../system";
import aiService from "../../ai";

const DEFAULT_MEMORY_GROUP_HISTORY_LIMIT = 300;
const DEFAULT_MEMORY_USER_HISTORY_LIMIT = 100;
const DEFAULT_EXPRESSION_LEARN_AFTER_MESSAGES = 100;
const DEFAULT_EXPRESSION_SAMPLE_SIZE = 8;

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
  return data;
}

export function createAIRoutes() {
  const app = new Hono();

  app.get("/base", (c) =>
    c.json({ ok: true, data: getChatConfig("base.json") }),
  );
  app.put("/base", async (c) => {
    const body = await c.req.json();
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

  app.get("/instances", (c) => {
    const names = aiService?.api?.list?.() ?? [];
    return c.json({ ok: true, data: names });
  });

  app.post("/instances", async (c) => {
    const body = await c.req.json();
    logger.info(`[webui-action] ai.instance.create`, {
      name: body?.name,
      apiUrl: body?.apiUrl,
      modelType: body?.modelType,
    });
    if (!aiService?.api?.create) {
      return c.json({ ok: false, error: "AI_SERVICE_UNAVAILABLE" }, 503);
    }

    await aiService.api.create({
      name: body.name,
      apiUrl: body.apiUrl,
      apiKey: body.apiKey,
      modelType: body.modelType || "text",
    });
    return c.json({ ok: true, data: aiService.api.list() });
  });

  app.delete("/instances/:name", (c) => {
    const name = c.req.param("name");
    logger.info(`[webui-action] ai.instance.remove`, { name });
    const ok = aiService?.api?.remove?.(name);
    return c.json({ ok: Boolean(ok) });
  });

  app.post("/default/:name", (c) => {
    const name = c.req.param("name");
    logger.info(`[webui-action] ai.instance.set-default`, { name });
    const ok = aiService?.api?.setDefault?.(name);
    return c.json({ ok: Boolean(ok) });
  });

  app.get("/skills", (c) => {
    const skills = aiService?.api?.getAllSkills?.();
    const tools = aiService?.api?.getAllTools?.();
    return c.json({
      ok: true,
      data: {
        skills: skills ? Array.from(skills.keys()) : [],
        tools: tools ? Array.from(tools.keys()) : [],
      },
    });
  });

  return app;
}
