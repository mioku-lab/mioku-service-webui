import { Hono } from "hono";
import { connectedBots, logger } from "mioki";

interface StrangerInfoResponse {
  ok: boolean;
  data?: { userId: string; nickname: string };
  error?: string;
}

interface CacheEntry {
  nickname: string | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

const nicknameCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | null>>();

function getConnectedBots(): any[] {
  return Array.from(connectedBots.values()).filter(Boolean);
}

function normalizeUserId(input: unknown): string {
  return String(input ?? "").trim();
}

function isValidQQNumber(id: string): boolean {
  return /^\d{5,12}$/.test(id);
}

function getCached(userId: string): string | null | undefined {
  const entry = nicknameCache.get(userId);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    nicknameCache.delete(userId);
    return undefined;
  }
  return entry.nickname;
}

function setCached(userId: string, nickname: string | null): void {
  nicknameCache.set(userId, {
    nickname,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

async function fetchNicknameFromBot(
  bot: any,
  userId: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await bot.api("get_stranger_info", { user_id: userId });
    const data = res?.data || res;
    const nickname = String(data?.nickname ?? "").trim();
    return nickname || null;
  } catch (error: any) {
    logger.warn(
      `stranger-info: bot ${bot?.uin || bot?.bot_id || "?"} 查询 ${userId} 失败: ${error?.message || error}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupNickname(userId: string): Promise<string | null> {
  const cached = getCached(userId);
  if (cached !== undefined) return cached;

  const pending = inflight.get(userId);
  if (pending) return pending;

  const promise = (async () => {
    const bots = getConnectedBots();
    if (bots.length === 0) {
      return null;
    }
    const results = await Promise.all(
      bots.map((bot) => fetchNicknameFromBot(bot, userId)),
    );
    for (const nickname of results) {
      if (nickname) {
        setCached(userId, nickname);
        return nickname;
      }
    }
    setCached(userId, null);
    return null;
  })();

  inflight.set(userId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(userId);
  }
}

export function createStrangerRoutes() {
  const app = new Hono();

  app.post("/info", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const userId = normalizeUserId(body?.user_id);
    if (!isValidQQNumber(userId)) {
      return c.json(
        { ok: false, error: "INVALID_USER_ID" } satisfies StrangerInfoResponse,
        400,
      );
    }

    try {
      const nickname = await lookupNickname(userId);
      if (!nickname) {
        return c.json(
          {
            ok: false,
            error: "NICKNAME_NOT_FOUND",
          } satisfies StrangerInfoResponse,
          404,
        );
      }
      return c.json({
        ok: true,
        data: { userId, nickname },
      } satisfies StrangerInfoResponse);
    } catch (error: any) {
      logger.error(`stranger-info 失败: ${error?.message || error}`);
      return c.json(
        {
          ok: false,
          error: "INTERNAL_ERROR",
        } satisfies StrangerInfoResponse,
        500,
      );
    }
  });

  return app;
}
