import { Hono } from "hono";
import { logger } from "mioku";
import { probeSkillSource } from "../skill-sources";
import {
  getSkillOrigin,
  installAgentSkill,
  listAgentSkillRoots,
  listAgentSkills,
  readAgentSkill,
  setSkillEnabled,
  uninstallAgentSkill,
} from "../skill-store";

function badRequest(c: { json: (body: unknown, status: 400) => Response }, error: string): Response {
  return c.json({ ok: false, error }, 400);
}

export function createAgentSkillRoutes() {
  const app = new Hono();

  app.get("/", async (c) => c.json({ ok: true, data: await listAgentSkills() }));

  app.get("/roots", async (c) =>
    c.json({ ok: true, data: await listAgentSkillRoots() }),
  );

  app.post("/probe", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const input = String(body?.input ?? "").trim();
    if (!input) return badRequest(c, "请填写技能来源");

    const result = await probeSkillSource(input);
    if ("error" in result) return badRequest(c, result.error);
    logger.info(`[webui-action] skill.probe`, {
      input,
      candidates: result.candidates.length,
    });
    return c.json({ ok: true, data: result });
  });

  app.post("/install", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rootId = String(body?.rootId ?? "").trim();
    if (!rootId) return badRequest(c, "请选择安装到哪个技能目录");

    const input = String(body?.input ?? "").trim();
    let stagingId = String(body?.stagingId ?? "").trim();
    let rel = String(body?.rel ?? "").trim();

    if (!stagingId) {
      if (!input) return badRequest(c, "请先检测来源");
      const probed = await probeSkillSource(input);
      if ("error" in probed) return badRequest(c, probed.error);
      stagingId = probed.stagingId;
      if (!rel) {
        if (probed.candidates.length > 1) {
          return c.json({
            ok: true,
            data: { needSelection: true, ...probed },
          });
        }
        rel = probed.candidates[0]!.rel;
      }
    }

    const result = await installAgentSkill({
      rootId,
      stagingId,
      rel,
      overwrite: Boolean(body?.overwrite),
      ...(body?.name ? { name: String(body.name) } : {}),
      ...(input ? { originInput: input } : {}),
    });
    if ("error" in result) return badRequest(c, result.error);

    logger.info(`[webui-action] skill.install`, {
      name: result.name,
      rootId: result.rootId,
    });
    return c.json({ ok: true, data: result });
  });

  app.put("/state", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim();
    if (!name) return badRequest(c, "缺少技能名");
    const enabled = body?.enabled !== false;
    const state = setSkillEnabled(name, enabled);
    logger.info(`[webui-action] skill.${enabled ? "enable" : "disable"}`, { name });
    return c.json({ ok: true, data: state });
  });

  app.get("/:name", async (c) => {
    const name = c.req.param("name");
    const rootId = c.req.query("rootId") ?? "";
    const detail = await readAgentSkill(rootId, name);
    if (!detail) return c.json({ ok: false, error: "技能不存在" }, 404);
    return c.json({ ok: true, data: detail });
  });

  app.delete("/:name", async (c) => {
    const name = c.req.param("name");
    const rootId = c.req.query("rootId") ?? "";
    const result = await uninstallAgentSkill(rootId, name);
    if ("error" in result) return badRequest(c, result.error);
    logger.info(`[webui-action] skill.uninstall`, { name, rootId });
    return c.json({ ok: true, data: result });
  });

  app.post("/:name/update", async (c) => {
    const name = c.req.param("name");
    const rootId = c.req.query("rootId") ?? "";
    const origin = getSkillOrigin(rootId, name);
    if (!origin) return badRequest(c, "该技能不是从来源安装的，无法自动更新");

    const probed = await probeSkillSource(origin.input);
    if ("error" in probed) return badRequest(c, probed.error);
    const match =
      probed.candidates.find((item) => item.name === name) ??
      probed.candidates[0]!;

    const result = await installAgentSkill({
      rootId,
      stagingId: probed.stagingId,
      rel: match.rel,
      name,
      overwrite: true,
      originInput: origin.input,
    });
    if ("error" in result) return badRequest(c, result.error);

    logger.info(`[webui-action] skill.update`, { name, rootId });
    return c.json({ ok: true, data: result });
  });

  return app;
}
