import * as crypto from "node:crypto";
import { logger } from "mioku";
import type { Context, Next } from "hono";
import type { AuthConfig } from "./types";
import { AUTH_PATH, WEEK_MS, readJsonFile, writeJsonFile } from "./utils";
import { notifyOwnersAuthTokenRefreshed } from "./system";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function ensureAuthConfig(): AuthConfig {
  const now = Date.now();
  const existing = readJsonFile<AuthConfig | null>(AUTH_PATH, null);

  if (!existing || !existing.token || !existing.expiresAt || existing.expiresAt <= now) {
    const generated: AuthConfig = {
      token: crypto.randomBytes(24).toString("hex"),
      createdAt: now,
      expiresAt: now + WEEK_MS,
    };
    writeJsonFile(AUTH_PATH, generated);
    void notifyOwnersAuthTokenRefreshed(
      generated.token,
      generated.expiresAt,
    ).catch((err) => {
      logger.warn(
        `[webui] 通知主人密钥更新失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return generated;
  }

  return existing;
}

/**
 * 距密钥过期多久时主动刷新（默认 6 小时）。
 * 提前刷新的好处：即便长时间没有 API 请求 / 登录触发，密钥也会轮换并通知主人。
 */
const AUTH_REFRESH_LEAD_MS = 6 * 60 * 60 * 1000;
/** 定时巡检周期（默认 60 秒）。 */
const AUTH_REFRESH_INTERVAL_MS = 60 * 1000;

let authRefreshTimer: NodeJS.Timeout | null = null;

/**
 * 启动密钥定时巡检。即使没有前端访问 / 没有登录请求，
 * 也会在密钥接近过期时主动刷新并通知主人。
 */
export function startAuthRefreshTimer(): void {
  if (authRefreshTimer) {
    return;
  }
  // 启动时立即巡检一次，处理"服务运行时密钥刚好过期"的场景
  try {
    ensureAuthConfig();
  } catch (err) {
    logger.warn(
      `[webui] 启动时巡检密钥失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  authRefreshTimer = setInterval(() => {
    try {
      const now = Date.now();
      const existing = readJsonFile<AuthConfig | null>(AUTH_PATH, null);
      // 仅在接近过期 / 已过期时才触发刷新逻辑，避免无意义的写文件
      if (
        existing &&
        existing.token &&
        existing.expiresAt &&
        existing.expiresAt - now > AUTH_REFRESH_LEAD_MS
      ) {
        return;
      }
      ensureAuthConfig();
    } catch (err) {
      logger.warn(
        `[webui] 定时巡检密钥失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, AUTH_REFRESH_INTERVAL_MS);
  // unref 避免阻塞进程退出
  if (typeof authRefreshTimer.unref === "function") {
    authRefreshTimer.unref();
  }
  logger.info(
    `[webui] 已启动密钥定时巡检（周期 ${AUTH_REFRESH_INTERVAL_MS / 1000}s，提前 ${AUTH_REFRESH_LEAD_MS / 60 / 60 / 1000}h 刷新）`,
  );
}

export function stopAuthRefreshTimer(): void {
  if (authRefreshTimer) {
    clearInterval(authRefreshTimer);
    authRefreshTimer = null;
  }
}

export function verifyAuthHeader(c: Context): boolean {
  const auth = c.req.header("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return false;
  }

  const authConfig = ensureAuthConfig();
  return safeEqual(token, authConfig.token) && Date.now() < authConfig.expiresAt;
}

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (!verifyAuthHeader(c)) {
    return c.json({ ok: false, error: "UNAUTHORIZED" }, 401);
  }
  await next();
}

export function loginWithToken(inputToken: string): { ok: boolean; expiresAt?: number } {
  const authConfig = ensureAuthConfig();
  if (!safeEqual(inputToken, authConfig.token)) {
    return { ok: false };
  }

  return { ok: true, expiresAt: authConfig.expiresAt };
}
