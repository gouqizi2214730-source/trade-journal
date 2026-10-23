/**
 * 入场位置自动标注（构建时复制到 apps/web/src/server/zh-location.ts）。
 *
 * 对 Bybit 账户的每笔交易，用 Bybit 公开 5 分钟 K 线（无需密钥）还原入场那一刻的：
 * 前日高低收、前日成交量分布（POC / VAH / VAL）、当日开盘、亚盘高低、
 * 当日 VWAP 与 ±σ 带、VWAP 斜率、入场前 2 小时的流动性扫荡，
 * 写成「位置·…」「时段·…」标签，报告里「按标签」就能看出哪种位置胜率高。
 *
 * 只用入场 K 线之前已经收盘的 K 线计算（当日开盘价除外），不偷看未来。
 * 时间按 UTC 日（北京时间 08:00 换日）划分，与 TradingView 加密货币默认的 VWAP 锚点一致。
 */
import { eq, inArray, like } from "drizzle-orm";
import { accounts, db, executions, settings, trades } from "@/db";
import { getSetting, setSetting } from "@/server/settings";

export const AUTO_TAG = /^(位置|时段)·/;
const VERSION = 1;
const M5 = 300_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const KEY = (tradeKey: string) => `zhLoc:${tradeKey}`;
const HOST = "https://api.bybit.com";

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Levels {
  pdh: number | null;
  pdl: number | null;
  pdc: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  open: number | null;
  asiaHigh: number | null;
  asiaLow: number | null;
  vwap: number | null;
  sigma: number | null;
  /** VWAP 最近 1 小时的变化，以 σ 为单位 */
  vwapSlope: number | null;
  /** 最近 14 根 5 分钟 K 线的平均波幅 */
  atr: number | null;
}

export interface LocationContext {
  v: number;
  key: string;
  symbol: string;
  direction: "long" | "short";
  entryAt: string;
  entry: number;
  computedAt: string;
  levels: Levels | null;
  tags: string[];
  notes: string[];
}

// ---------------------------------------------------------------- 纯计算

const vwapOf = (bars: Bar[]) => {
  let pv = 0,
    pv2 = 0,
    vol = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    pv2 += tp * tp * b.v;
    vol += b.v;
  }
  if (vol <= 0) return null;
  const vwap = pv / vol;
  return { vwap, sigma: Math.sqrt(Math.max(0, pv2 / vol - vwap * vwap)) };
};

/** 成交量分布：每根 K 线的量平均摊到它覆盖的价格格子里，70% 价值区按 POC 向两侧扩展 */
export const volumeProfile = (bars: Bar[], bins = 60) => {
  if (bars.length === 0) return null;
  const hi = Math.max(...bars.map((b) => b.h));
  const lo = Math.min(...bars.map((b) => b.l));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array<number>(bins).fill(0);
  const cell = (p: number) => Math.min(bins - 1, Math.max(0, Math.floor((p - lo) / step)));
  for (const b of bars) {
    if (!(b.v > 0)) continue;
    const a = cell(b.l),
      z = cell(b.h);
    const share = b.v / (z - a + 1);
    for (let i = a; i <= z; i++) vol[i]! += share;
  }
  const total = vol.reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  let poc = 0;
  for (let i = 1; i < bins; i++) if (vol[i]! > vol[poc]!) poc = i;
  let up = poc,
    dn = poc,
    acc = vol[poc]!;
  while (acc < total * 0.7 && (up < bins - 1 || dn > 0)) {
    const above = up < bins - 1 ? vol[up + 1]! : -1;
    const below = dn > 0 ? vol[dn - 1]! : -1;
    if (above >= below) acc += vol[++up]!;
    else acc += vol[--dn]!;
  }
  return { poc: lo + (poc + 0.5) * step, vah: lo + (up + 1) * step, val: lo + dn * step };
};

export const sessionTag = (entryAt: number) => {
  const h = new Date(entryAt).getUTCHours();
  return h < 8 ? "时段·亚盘" : h < 13 ? "时段·欧盘" : h < 20 ? "时段·美盘" : "时段·美盘尾";
};

/**
 * prev：前一个 UTC 日的全部 5 分钟 K 线；day：入场当日的 K 线（可含入场之后的，会被截掉）。
 */
export function analyze(
  prev: Bar[],
  day: Bar[],
  entryAt: number,
  entry: number,
  direction: "long" | "short",
): { levels: Levels; tags: string[]; notes: string[] } {
  const tags = [sessionTag(entryAt)];
  const notes: string[] = [];
  const dayStart = Math.floor(entryAt / DAY) * DAY;
  const entryBar = Math.floor(entryAt / M5) * M5;
  const today = day.filter((b) => b.t >= dayStart && b.t < entryBar);
  const openBar = day.find((b) => b.t === dayStart) ?? day.find((b) => b.t >= dayStart && b.t <= entryBar);
  const before = [...prev, ...today];

  const levels: Levels = {
    pdh: null,
    pdl: null,
    pdc: null,
    poc: null,
    vah: null,
    val: null,
    open: openBar?.o ?? null,
    asiaHigh: null,
    asiaLow: null,
    vwap: null,
    sigma: null,
    vwapSlope: null,
    atr: null,
  };

  // 前日
  if (prev.length >= 48) {
    levels.pdh = Math.max(...prev.map((b) => b.h));
    levels.pdl = Math.min(...prev.map((b) => b.l));
    levels.pdc = prev[prev.length - 1]!.c;
    const vp = volumeProfile(prev);
    if (vp) Object.assign(levels, vp);
  } else notes.push("前一日 K 线不足，未计算前日高低点和价值区");

  // 亚盘（UTC 00:00–08:00）只在入场时已经走完才算
  if (entryAt >= dayStart + 8 * HOUR) {
    const asia = today.filter((b) => b.t < dayStart + 8 * HOUR);
    if (asia.length >= 24) {
      levels.asiaHigh = Math.max(...asia.map((b) => b.h));
      levels.asiaLow = Math.min(...asia.map((b) => b.l));
    }
  }

  // VWAP（当日锚定）
  if (today.length >= 6) {
    const now = vwapOf(today);
    if (now && now.sigma > 0) {
      levels.vwap = now.vwap;
      levels.sigma = now.sigma;
      if (today.length >= 18) {
        const ago = vwapOf(today.slice(0, today.length - 12));
        if (ago) levels.vwapSlope = (now.vwap - ago.vwap) / now.sigma;
      }
    }
  } else notes.push("当日开盘不到 30 分钟，VWAP 还不稳定，未标注 VWAP 位置");

  if (before.length >= 14) {
    const last = before.slice(-14);
    levels.atr = last.reduce((s, b) => s + (b.h - b.l), 0) / last.length;
  }

  // 开盘 / 入场 相对前日价值区
  const { vah, val, poc } = levels;
  if (vah != null && val != null && poc != null && vah > val) {
    if (levels.open != null)
      tags.push(
        levels.open > vah
          ? "位置·开盘在前日价值区上方"
          : levels.open < val
            ? "位置·开盘在前日价值区下方"
            : "位置·开盘在前日价值区内",
      );
    const near = (vah - val) * 0.15;
    tags.push(
      Math.abs(entry - vah) <= near
        ? "位置·入场靠前日 VAH"
        : Math.abs(entry - val) <= near
          ? "位置·入场靠前日 VAL"
          : Math.abs(entry - poc) <= near
            ? "位置·入场靠前日 POC"
            : entry > vah
              ? "位置·入场在前日价值区上方"
              : entry < val
                ? "位置·入场在前日价值区下方"
                : "位置·入场在前日价值区中间",
    );
  }

  // VWAP 带与斜率
  if (levels.vwap != null && levels.sigma) {
    const z = (entry - levels.vwap) / levels.sigma;
    tags.push(
      Math.abs(z) <= 1
        ? "位置·VWAP ±1σ 内"
        : z > 2
          ? "位置·VWAP 上方 2σ 外"
          : z > 1
            ? "位置·VWAP 上方 1–2σ"
            : z < -2
              ? "位置·VWAP 下方 2σ 外"
              : "位置·VWAP 下方 1–2σ",
    );
    if (levels.vwapSlope != null) {
      const s = levels.vwapSlope;
      tags.push(
        Math.abs(s) < 0.2
          ? "位置·VWAP 走平"
          : (s > 0) === (direction === "long")
            ? "位置·顺 VWAP 斜率"
            : "位置·逆 VWAP 斜率",
      );
    }
  }

  // 入场前 2 小时内的流动性扫荡：刺破后收回，且之后没有再收到外面
  if (levels.pdh != null && levels.pdl != null) {
    const win = before.slice(-24);
    const swept = (lvl: number | null, below: boolean) => {
      if (lvl == null) return false;
      const i = win.findIndex((b) => (below ? b.l < lvl && b.c > lvl : b.h > lvl && b.c < lvl));
      return i >= 0 && win.slice(i).every((b) => (below ? b.c > lvl : b.c < lvl));
    };
    const found =
      direction === "long"
        ? [
            swept(levels.pdl, true) && "位置·扫前日低点后做多",
            swept(levels.asiaLow, true) && "位置·扫亚盘低点后做多",
          ]
        : [
            swept(levels.pdh, false) && "位置·扫前日高点后做空",
            swept(levels.asiaHigh, false) && "位置·扫亚盘高点后做空",
          ];
    const hits = found.filter((x): x is string => Boolean(x));
    tags.push(...(hits.length ? hits : ["位置·入场前无扫荡"]));
  }

  // 关键位：入场价在 1.5 倍 ATR 以内的最近一个
  if (levels.atr) {
    const cands: [string, number | null][] = [
      ["前日高点", levels.pdh],
      ["前日低点", levels.pdl],
      ["前日收盘", levels.pdc],
      ["当日开盘价", levels.open],
      ["亚盘高点", levels.asiaHigh],
      ["亚盘低点", levels.asiaLow],
    ];
    let best: [string, number] | null = null;
    for (const [name, p] of cands) {
      if (p == null) continue;
      const d = Math.abs(entry - p);
      if (d <= levels.atr * 1.5 && (!best || d < best[1])) best = [name, d];
    }
    tags.push(best ? `位置·靠${best[0]}` : "位置·不在关键位附近");
  }

  return { levels, tags, notes };
}

// ---------------------------------------------------------------- Bybit 公开 K 线

class Unsupported extends Error {}
const dayCache = new Map<string, Bar[]>();

const readKline = async (category: string, symbol: string, start: number, end: number) => {
  const q = new URLSearchParams({
    category,
    symbol,
    interval: "5",
    start: String(start),
    end: String(end - 1),
    limit: "1000",
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HOST}/v5/market/kline?${q}`, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const json = (await res.json().catch(() => null)) as {
      retCode?: number;
      retMsg?: string;
      result?: { list?: string[][] };
    } | null;
    if (!json) throw new Error(`Bybit K 线请求失败（HTTP ${res.status}）`);
    if (json.retCode === 10006 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (json.retCode === 10001 && /symbol/i.test(json.retMsg ?? ""))
      throw new Unsupported(`Bybit 没有 ${symbol} 的 K 线`);
    if (json.retCode !== 0) throw new Error(`Bybit K 线：${json.retMsg ?? json.retCode}`);
    return (json.result?.list ?? [])
      .map((r) => ({ t: +r[0]!, o: +r[1]!, h: +r[2]!, l: +r[3]!, c: +r[4]!, v: +r[5]! }))
      .filter((b) => b.t >= start && b.t < end && [b.o, b.h, b.l, b.c, b.v].every(Number.isFinite));
  }
};

const dayBars = async (category: string, symbol: string, dayStart: number) => {
  const now = Date.now();
  const complete = dayStart + DAY + M5 <= now;
  const key = `${category}:${symbol}:${dayStart}`;
  const hit = dayCache.get(key);
  if (hit) return hit;
  const bars = (await readKline(category, symbol, dayStart, Math.min(dayStart + DAY, now))).sort(
    (a, b) => a.t - b.t,
  );
  if (complete) {
    dayCache.set(key, bars);
    if (dayCache.size > 600) dayCache.delete(dayCache.keys().next().value!);
  }
  return bars;
};

// ---------------------------------------------------------------- 交易

type TradeRow = typeof trades.$inferSelect;

const bybitAccountIds = () =>
  db
    .select({ id: accounts.id, broker: accounts.broker })
    .from(accounts)
    .all()
    .filter((a) => a.broker === "bybit")
    .map((a) => a.id);

export const readContext = (tradeKey: string): LocationContext | null => {
  const raw = getSetting(KEY(tradeKey));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocationContext;
  } catch {
    return null;
  }
};

const firstFill = (row: TradeRow) => {
  const ids = JSON.parse(row.executionIdsJson || "[]") as string[];
  const fills = ids.length
    ? db.select().from(executions).where(inArray(executions.id, ids.slice(0, 200))).all()
    : [];
  fills.sort((a, b) => a.executedAt.localeCompare(b.executedAt));
  const f = fills[0];
  return f ? { at: Date.parse(f.executedAt), price: f.price } : { at: Date.parse(row.openedAt), price: row.avgEntry };
};

const writeTags = (row: TradeRow, auto: string[]) => {
  const own = (JSON.parse(row.tagsJson || "[]") as string[]).filter((t) => !AUTO_TAG.test(t));
  const next = [...own, ...auto].slice(0, 100);
  db.update(trades).set({ tagsJson: JSON.stringify(next) }).where(eq(trades.key, row.key)).run();
};

export const eligible = (row: TradeRow, ids = bybitAccountIds()) => ids.includes(row.accountId);

export async function locateTrade(row: TradeRow): Promise<LocationContext> {
  const symbol = row.symbol.endsWith(".SPOT") ? row.symbol.slice(0, -5) : row.symbol;
  const category = row.symbol.endsWith(".SPOT") ? "spot" : "linear";
  const fill = firstFill(row);
  const dayStart = Math.floor(fill.at / DAY) * DAY;
  const base: Omit<LocationContext, "levels" | "tags" | "notes"> = {
    v: VERSION,
    key: row.key,
    symbol: row.symbol,
    direction: row.direction as "long" | "short",
    entryAt: new Date(fill.at).toISOString(),
    entry: fill.price,
    computedAt: new Date().toISOString(),
  };
  let ctx: LocationContext;
  try {
    const prev = await dayBars(category, symbol, dayStart - DAY);
    const day = await dayBars(category, symbol, dayStart);
    const r = analyze(prev, day, fill.at, fill.price, base.direction);
    ctx = { ...base, ...r };
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    ctx = { ...base, levels: null, tags: [sessionTag(fill.at)], notes: [error.message] };
  }
  setSetting(KEY(row.key), JSON.stringify(ctx));
  writeTags(row, ctx.tags);
  return ctx;
}

/** 「全部重新计算」：清掉已保存的位置信息，之后按未标注处理 */
export const clearContexts = () => db.delete(settings).where(like(settings.key, "zhLoc:%")).run();

/** 给还没标注（或入场时间变了）的交易补标注，最近的交易优先 */
export async function locatePending({ limit = 40, force = false } = {}) {
  const ids = bybitAccountIds();
  if (ids.length === 0) return { done: 0, failed: 0, remaining: 0, errors: [] as string[] };
  // 有 Bybit 账户时，顺手把「行情数据与回放」的 Bybit 公开行情源打开一次（之后用户关掉不再干预）
  if (!getSetting("zhBybitMarketAuto")) {
    setSetting("zhBybitMarketAuto", "1");
    if (!getSetting("marketData:bybit:keyEnc")) setSetting("marketData:bybit:keyEnc", "enabled");
  }
  const rows = db.select().from(trades).where(inArray(trades.accountId, ids)).all();
  const saved = new Map(
    db
      .select()
      .from(settings)
      .where(like(settings.key, "zhLoc:%"))
      .all()
      .map((s) => {
        try {
          return [s.key.slice(6), JSON.parse(s.value) as LocationContext] as const;
        } catch {
          return [s.key.slice(6), null] as const;
        }
      }),
  );
  const pending = rows
    .filter((r) => {
      if (force) return true;
      const c = saved.get(r.key);
      // 没算过、算法升级、或首笔成交时间变了（例如改了成交记录）才重新计算；
      // 手动删掉的自动标签不会被加回来
      return !c || c.v !== VERSION || Date.parse(c.entryAt) !== Date.parse(r.openedAt);
    })
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  let done = 0,
    failed = 0,
    streak = 0;
  const errors = new Set<string>();
  for (const row of pending.slice(0, limit)) {
    try {
      await locateTrade(row);
      await new Promise((r) => setTimeout(r, 120));
      done++;
      streak = 0;
    } catch (error) {
      failed++;
      errors.add(error instanceof Error ? error.message : String(error));
      if (++streak >= 3) break; // 网络不通时别一直试
    }
  }
  return { done, failed, remaining: Math.max(0, pending.length - done), errors: [...errors].slice(0, 3) };
}
