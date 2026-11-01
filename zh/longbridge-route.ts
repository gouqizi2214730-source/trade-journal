/**
 * 长桥 OAuth 接口（构建时复制到 apps/web/src/app/api/zh-longbridge/route.ts）
 *   POST { action: "start", accountId? } → { url, state }  浏览器打开 url 授权
 *   GET  ?status=<state>                → { status, ref?, error? }
 *   GET  ?code=…&state=…                → 长桥授权后的回调页面
 *   POST { action: "bind", accountId, ref } → 把重新授权的结果写回已有账户
 */
import { eq } from "drizzle-orm";
import { accounts, db } from "@/db";
import { bad, handler, ok, requireValue } from "@/server/api";
import { decryptJson, encryptJson } from "@/server/crypto";
import {
  authorizationStatus,
  completeAuthorization,
  hasToken,
  startAuthorization,
} from "@/server/zh-longbridge-oauth";

const page = (title: string, text: string, okay: boolean) =>
  new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#111;color:#e5e5e5;display:grid;place-items:center;min-height:100vh;margin:0}
main{text-align:center;padding:2rem;max-width:32rem}h1{font-size:1.4rem;color:${okay ? "#4ade80" : "#f87171"}}p{color:#a3a3a3;line-height:1.6}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`,
    { status: okay ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const accountRef = (accountId: string) => {
  const row = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  requireValue(row && row.broker === "longbridge" && row.credentialsEnc, "找不到这个长桥账户");
  return { row, creds: decryptJson<Record<string, string>>(row.credentialsEnc!) };
};

// 回调由系统浏览器发起，带不上复盘本的登录 cookie，所以设为公开；靠一次性的 state 校验
export const GET = handler(
  async (request: Request) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    if (status) return ok(authorizationStatus(status));
    const state = url.searchParams.get("state");
    if (!state) return bad("缺少 state");
    try {
      await completeAuthorization(state, url.searchParams.get("code"), url.searchParams.get("error_description") || url.searchParams.get("error"));
      return page("长桥授权成功", "可以关闭这个页面，回到复盘本继续。", true);
    } catch (e) {
      return page("长桥授权失败", esc(e instanceof Error ? e.message : String(e)), false);
    }
  },
  { public: true },
);

export const POST = handler(async (request: Request) => {
  const body = (await request.json().catch(() => ({}))) as { action?: string; accountId?: string; ref?: string };
  if (body.action === "start") {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    const ref = body.accountId ? accountRef(body.accountId).creds.zhOAuth : undefined;
    try {
      return ok(await startAuthorization(`http://${host}`, ref));
    } catch (e) {
      return bad(e instanceof Error ? e.message : "无法开始长桥授权", 502);
    }
  }
  if (body.action === "bind") {
    requireValue(body.accountId && body.ref && hasToken(body.ref), "授权还没完成");
    const { creds } = accountRef(body.accountId);
    const { appKey: _a, appSecret: _s, accessToken: _t, ...rest } = creds;
    db.update(accounts)
      .set({ credentialsEnc: encryptJson({ ...rest, zhOAuth: body.ref }) })
      .where(eq(accounts.id, body.accountId))
      .run();
    return ok({ ok: true });
  }
  return bad("未知操作");
});
