/**
 * 长桥 OpenAPI OAuth 2.0（构建时复制到 apps/web/src/server/zh-longbridge-oauth.ts）。
 *
 * 流程与官方 SDK（longbridge/openapi · rust/crates/oauth）一致：
 *   1. POST {base}/oauth2/register 动态注册客户端（公共客户端，无 secret），回调地址指向本机复盘本服务；
 *   2. 浏览器打开 {base}/oauth2/authorize，用户登录长桥并勾选权限；
 *   3. 回调拿到 code，POST {base}/oauth2/token 换取 access_token / refresh_token；
 *   4. 调接口时带 X-Api-Key: client_id、Authorization: Bearer <token>，不需要 HMAC 签名；
 *      快过期时用 refresh_token 自动续期。
 * 令牌加密保存在本机数据库（settings 表），账户凭据里只存一个引用 id。
 */
import { createHash, randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "@/server/crypto";
import { getSetting, setSetting } from "@/server/settings";

const BASE_COM = "https://openapi.longbridge.com";
const BASE_CN = "https://openapi.longbridge.cn";
const TOKEN_KEY = (ref: string) => `zhLbToken:${ref}`;
const CLIENT_KEY = (base: string, redirect: string) => `zhLbClient:${base}|${redirect}`;

export interface LbToken {
  base: string;
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  /** 毫秒时间戳 */
  expiresAt: number;
}

interface Pending {
  base: string;
  clientId: string;
  redirect: string;
  verifier: string;
  ref: string;
  createdAt: number;
  status: "pending" | "done" | "error";
  error?: string;
}

// 开发模式热重载时保留进行中的授权
const g = globalThis as unknown as { __zhLbPending?: Map<string, Pending>; __zhLbCn?: boolean };
const pending = (g.__zhLbPending ??= new Map());

/** 和官方 SDK 一样：能访问 geotest.lbkrs.com 视为中国大陆网络，用 .cn 域名 */
const isCn = async () => {
  if (g.__zhLbCn !== undefined) return g.__zhLbCn;
  try {
    const res = await fetch("https://geotest.lbkrs.com", { signal: AbortSignal.timeout(3000) });
    g.__zhLbCn = res.status === 200;
  } catch {
    g.__zhLbCn = false;
  }
  return g.__zhLbCn;
};

const readError = async (res: Response) => {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error_description?: string; error?: string; message?: string };
    return j.error_description || j.message || j.error || text || `HTTP ${res.status}`;
  } catch {
    return text.slice(0, 200) || `HTTP ${res.status}`;
  }
};

const register = async (base: string, redirect: string) => {
  const cached = getSetting(CLIENT_KEY(base, redirect));
  if (cached) return cached;
  const res = await fetch(`${base}/oauth2/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "复盘本 FupanBook",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`长桥注册授权客户端失败：${await readError(res)}`);
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error("长桥注册授权客户端失败：没有返回 client_id");
  setSetting(CLIENT_KEY(base, redirect), body.client_id);
  return body.client_id;
};

const b64url = (buf: Buffer) => buf.toString("base64url");

/** 开始授权，返回要在浏览器打开的地址 */
export async function startAuthorization(origin: string, ref?: string) {
  const base = (await isCn()) ? BASE_CN : BASE_COM;
  const port = new URL(origin).port;
  const redirect = `http://localhost:${port}/api/zh-longbridge`;
  const clientId = await register(base, redirect);
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  for (const [k, p] of pending) if (Date.now() - p.createdAt > 15 * 60_000) pending.delete(k);
  pending.set(state, {
    base,
    clientId,
    redirect,
    verifier,
    ref: ref || b64url(randomBytes(12)),
    createdAt: Date.now(),
    status: "pending",
  });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    state,
    scope: "",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${base}/oauth2/authorize?${q}`, state };
}

export const authorizationStatus = (state: string) => {
  const p = pending.get(state);
  if (!p) return { status: "error" as const, error: "授权已过期，请重新点击授权" };
  return { status: p.status, ref: p.status === "done" ? p.ref : undefined, error: p.error };
};

const tokenRequest = async (base: string, form: Record<string, string>) => {
  const res = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(await readError(res));
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("没有返回 access_token");
  return j;
};

/** 浏览器回调：用 code 换令牌 */
export async function completeAuthorization(state: string, code: string | null, error: string | null) {
  const p = pending.get(state);
  if (!p) throw new Error("授权已过期或已完成，请回到复盘本重新点击授权");
  try {
    if (error || !code) throw new Error(error || "长桥没有返回授权码");
    const j = await tokenRequest(p.base, {
      grant_type: "authorization_code",
      code,
      redirect_uri: p.redirect,
      client_id: p.clientId,
      code_verifier: p.verifier,
    });
    saveToken(p.ref, {
      base: p.base,
      clientId: p.clientId,
      accessToken: j.access_token!,
      refreshToken: j.refresh_token ?? null,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    });
    p.status = "done";
  } catch (e) {
    p.status = "error";
    p.error = `长桥授权失败：${e instanceof Error ? e.message : String(e)}`;
    throw new Error(p.error);
  }
}

const saveToken = (ref: string, token: LbToken) => setSetting(TOKEN_KEY(ref), encryptJson(token));

export const hasToken = (ref: string) => Boolean(getSetting(TOKEN_KEY(ref)));

/** 取可用的令牌，快过期（5 分钟内）或 force 时先续期 */
export async function getToken(ref: string, force = false): Promise<LbToken> {
  const raw = getSetting(TOKEN_KEY(ref));
  if (!raw) throw new Error("长桥还没有授权：请到「导入 → 连接券商」选择长桥并点「在浏览器中授权」");
  const t = decryptJson<LbToken>(raw);
  if (!force && t.expiresAt - Date.now() > 5 * 60_000) return t;
  if (!t.refreshToken) throw new Error("长桥授权已过期，请在「账户」页点「重新授权」");
  try {
    const j = await tokenRequest(t.base, {
      grant_type: "refresh_token",
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    const next: LbToken = {
      ...t,
      accessToken: j.access_token!,
      refreshToken: j.refresh_token ?? t.refreshToken,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    };
    saveToken(ref, next);
    return next;
  } catch (e) {
    throw new Error(
      `长桥授权已过期，自动续期失败（${e instanceof Error ? e.message : String(e)}），请在「账户」页点「重新授权」`,
    );
  }
}
