/**
 * 入场位置自动标注接口（构建时复制到 apps/web/src/app/api/zh-location/route.ts）
 *   GET  ?key=交易键        → 已保存的位置信息
 *   POST { key }            → 重新计算这一笔
 *   POST { limit?, force? } → 补全还没标注的交易（桌面版同步后自动调用）
 */
import { bad, handler, ok, requireValue } from "@/server/api";
import { getTradeByKey } from "@/server/trades-query";
import { clearContexts, eligible, locatePending, locateTrade, readContext } from "@/server/zh-location";

export const GET = handler(async (request: Request) => {
  const key = new URL(request.url).searchParams.get("key");
  requireValue(key, "缺少交易键");
  const row = getTradeByKey(key);
  if (!row) return bad("找不到这笔交易", 404);
  return ok({ eligible: eligible(row), context: readContext(key) });
});

export const POST = handler(async (request: Request) => {
  const body = (await request.json().catch(() => ({}))) as { key?: unknown; limit?: unknown; force?: unknown };
  if (typeof body.key === "string") {
    const row = getTradeByKey(body.key);
    if (!row) return bad("找不到这笔交易", 404);
    if (!eligible(row)) return bad("目前只支持 Bybit 账户的交易（用 Bybit 公开 K 线计算）");
    try {
      return ok({ context: await locateTrade(row) });
    } catch (error) {
      return bad(error instanceof Error ? error.message : "计算失败", 502);
    }
  }
  const limit = typeof body.limit === "number" ? Math.min(500, Math.max(1, Math.floor(body.limit))) : 40;
  if (body.force === true) clearContexts();
  return ok(await locatePending({ limit }));
});
