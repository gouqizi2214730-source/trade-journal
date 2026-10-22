/**
 * 复盘本的券商扩展（构建时由 zh/apply.mjs 复制到 apps/web/src/server/zh-brokers.ts）。
 *
 * LuxAlgo 的 @luxalgo/broker-sdk 对 Bybit 只读钱包余额（trades 恒为空），也没有长桥。
 * 这里包一层：
 *   - bybit：余额仍走 SDK，另外调用 Bybit V5「成交记录」接口补上 USDT/USDC 永续和现货成交；
 *   - longbridge：长桥 OpenAPI（App Key + App Secret + Access Token），余额、持仓、历史成交；
 *   - 其他券商：原样交给 SDK。
 * 全部是只读请求，不会下单。
 */
import { createHash, createHmac } from "node:crypto";
import {
  connect as sdkConnect,
  listBrokers as sdkListBrokers,
  type BrokerInfo,
  type Trade,
} from "@luxalgo/broker-sdk";

type Credentials = Record<string, string>;
type SnapshotAccount = {
  id: string;
  name: string;
  currency: string;
  equity: number;
  cash?: number;
  positions: { symbol: string; quantity: number; marketValue?: number; averageEntryPrice?: number; assetClass?: string }[];
  trades: Trade[];
};
type Snapshot = { broker: string; fetchedAt: string; accounts: SnapshotAccount[] };
type Connection = {
  broker: string;
  label: string;
  credentials: Credentials;
  fetchSnapshot: () => Promise<Snapshot>;
  fetchBars: (...args: unknown[]) => Promise<never>;
};
export type ExtConnectOptions = {
  broker: string;
  credentials: Credentials;
  /** 上次成功同步的时间：有则只补拉之后的成交（往前多取 3 天防漏），没有则回溯 2 年 */
  zhSince?: string | null;
  [key: string]: unknown;
};

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : NaN;
};
const startFrom = (since: string | null | undefined, maxBackDays: number): number => {
  const floor = Date.now() - maxBackDays * DAY;
  const t = since ? Date.parse(since) : NaN;
  return Number.isFinite(t) ? Math.max(floor, t - 3 * DAY) : floor;
};

// ============================================================================ Bybit
const BYBIT_API = "https://api.bybit.com";
const BYBIT_RECV = "20000";
const BYBIT_TRADE_TYPES = new Set(["Trade", "AdlTrade", "BustTrade", "BlockTrade"]);
const QUOTES = ["USDT", "USDC", "USDE", "USD1", "FDUSD", "DAI", "BTC", "ETH", "EUR", "BRL", "TRY"];

const bybitGet = async (creds: Credentials, path: string, params: Record<string, string>) => {
  const query = new URLSearchParams(params).toString();
  for (let attempt = 0; ; attempt++) {
    const timestamp = Date.now().toString();
    const sign = createHmac("sha256", creds.apiSecret!)
      .update(timestamp + creds.apiKey + BYBIT_RECV + query)
      .digest("hex");
    const res = await fetch(`${BYBIT_API}${path}?${query}`, {
      headers: {
        "X-BAPI-API-KEY": creds.apiKey!,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": BYBIT_RECV,
        "X-BAPI-SIGN": sign,
      },
    });
    const body = (await res.json().catch(() => null)) as {
      retCode?: number;
      retMsg?: string;
      result?: { list?: Record<string, string>[]; nextPageCursor?: string };
    } | null;
    // 10006 = 请求过于频繁：等一等再试
    if ((res.status === 429 || body?.retCode === 10006) && attempt < 5) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok || !body) throw new Error(`Bybit 成交接口请求失败（HTTP ${res.status}）`);
    return body;
  }
};

/** 现货手续费可能以基础币计（例如买入 BTC 扣 BTC），换算成计价币 */
const bybitSpotFee = (symbol: string, fee: number, feeCurrency: string | undefined, price: number) => {
  if (!feeCurrency) return fee;
  const quote = QUOTES.find((q) => symbol.endsWith(q));
  const base = quote ? symbol.slice(0, -quote.length) : "";
  return base && feeCurrency === base ? fee * price : fee;
};

export const fetchBybitTrades = async (creds: Credentials, since?: string | null): Promise<Trade[]> => {
  const trades: Trade[] = [];
  const now = Date.now();
  const begin = startFrom(since, 730); // Bybit 成交记录最多保留 2 年
  // linear = USDT/USDC 永续与交割；spot = 现货。反向合约（币本位）盈亏按币计，日志无法正确计算，暂不同步。
  const failures: string[] = [];
  let succeeded = 0;
  for (const category of ["linear", "spot"] as const) {
    try {
    for (let end = now; end > begin; end -= 7 * DAY) {
      const start = Math.max(begin, end - 7 * DAY + 1);
      let cursor = "";
      for (let page = 0; page < 200; page++) {
        const params: Record<string, string> = {
          category,
          startTime: String(start),
          endTime: String(end),
          limit: "100",
        };
        if (cursor) params.cursor = cursor;
        const body = await bybitGet(creds, "/v5/execution/list", params);
        if (body.retCode !== 0) {
          // 超出可查询的历史范围：停止往前翻，保留已取到的
          if (/time|range|exceed|older/i.test(body.retMsg ?? "")) break;
          throw new Error(`Bybit 成交接口返回错误：${body.retMsg ?? body.retCode}`);
        }
        for (const e of body.result?.list ?? []) {
          if (e.execType && !BYBIT_TRADE_TYPES.has(e.execType)) continue; // 资金费率、交割等不是成交
          const quantity = num(e.execQty);
          const price = num(e.execPrice);
          const time = Number.parseInt(e.execTime ?? "", 10);
          if (!(quantity > 0) || !Number.isFinite(price) || !Number.isFinite(time)) continue;
          const rawFee = num(e.execFee);
          const fee = Number.isFinite(rawFee)
            ? category === "spot"
              ? bybitSpotFee(e.symbol ?? "", rawFee, e.feeCurrency, price)
              : rawFee
            : 0;
          trades.push({
            // 现货和永续同名（BTCUSDT），加后缀分开，否则会被拼进同一笔交易
            symbol: category === "spot" ? `${e.symbol}.SPOT` : e.symbol!,
            side: e.side === "Sell" ? "sell" : "buy",
            quantity,
            price,
            fee,
            executedAt: new Date(time).toISOString(),
          });
        }
        cursor = body.result?.nextPageCursor ?? "";
        if (!cursor) break;
        await sleep(120);
      }
      await sleep(120);
    }
    succeeded++;
    } catch (error) {
      // 例如 API Key 没开该品类的读取权限：跳过这个品类，不影响余额和其他品类
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zh-brokers] Bybit ${category} 成交同步失败：${message}`);
      failures.push(`${category === "linear" ? "合约" : "现货"}：${message}`);
    }
  }
  if (succeeded === 0 && failures.length)
    throw new Error(
      `Bybit 成交同步失败（${failures.join("；")}）。请确认 API Key 勾选了合约和现货的「只读」订单/持仓权限。`,
    );
  return trades;
};

// ============================================================================ 长桥 Longbridge / LongPort
const LONGBRIDGE_HOSTS = ["https://openapi.longbridge.com", "https://openapi.longbridge.cn", "https://openapi.longportapp.com"];
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

/** 签名规则与官方 SDK（longportapp/openapi-sdk · httpclient/signature.rs）一致 */
const longbridgeHeaders = (creds: Credentials, method: string, path: string, query: string) => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedValues = `authorization:${creds.accessToken}\nx-api-key:${creds.appKey}\nx-timestamp:${timestamp}\n`;
  const signedHeaders = "authorization;x-api-key;x-timestamp";
  const canonical = `${method}|${path}|${query}|${signedValues}|${signedHeaders}|`;
  const toSign = `HMAC-SHA256|${sha1(canonical)}`;
  const signature = createHmac("sha256", creds.appSecret!).update(toSign, "utf8").digest("hex");
  const region = [creds.appKey, creds.appSecret, creds.accessToken].some((c) => c?.startsWith("us_")) ? "us" : "ap";
  return {
    "X-Api-Key": creds.appKey!,
    Authorization: creds.accessToken!,
    "X-Timestamp": timestamp,
    "X-Api-Signature": `HMAC-SHA256 SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-dc-region": region,
    "Content-Type": "application/json; charset=utf-8",
  };
};

let longbridgeHost: string | null = null;
const longbridgeGet = async <T>(creds: Credentials, path: string, params: Record<string, string> = {}): Promise<T> => {
  const query = new URLSearchParams(params).toString();
  const hosts = longbridgeHost ? [longbridgeHost] : LONGBRIDGE_HOSTS;
  let lastError: unknown = null;
  for (const host of hosts) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${host}${path}${query ? `?${query}` : ""}`, {
          headers: longbridgeHeaders(creds, "GET", path, query),
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        lastError = error; // 网络不通：换下一个域名
        break;
      }
      const body = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
      if (res.status === 429 && attempt < 3) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      longbridgeHost = host;
      if (res.status === 401 || res.status === 403)
        throw new Error("长桥认证失败：请检查 App Key、App Secret 和 Access Token（Access Token 有有效期，过期需在开发者中心重新生成）");
      if (!res.ok || !body || body.code !== 0)
        throw new Error(`长桥接口返回错误：${body?.message ?? `HTTP ${res.status}`}`);
      return body.data as T;
    }
  }
  throw new Error(`无法连接长桥 OpenAPI：${lastError instanceof Error ? lastError.message : "网络错误"}`);
};

type LbExecution = { trade_id: string; symbol: string; trade_done_at: string; quantity: string; price: string; side: string };

const longbridgeMarkets = (creds: Credentials): Set<string> | null => {
  const raw = (creds.markets ?? "").trim();
  if (raw.toUpperCase() === "ALL" || raw === "全部") return null;
  const list = (raw || "US").split(/[\s,，;；]+/).map((m) => m.trim().toUpperCase()).filter(Boolean);
  return new Set(list);
};

const fetchLongbridge = async (creds: Credentials, since?: string | null): Promise<Snapshot> => {
  if (!creds.appKey || !creds.appSecret || !creds.accessToken)
    throw new Error("长桥连接需要 App Key、App Secret 和 Access Token");
  const markets = longbridgeMarkets(creds);
  const inMarket = (symbol: string) => !markets || markets.has(symbol.split(".").pop()!.toUpperCase());
  const currency = (creds.currency || (markets && markets.size === 1 && markets.has("HK") ? "HKD" : "USD")).toUpperCase();

  // 余额（按账户币种折算的净资产）
  const balance = await longbridgeGet<{ list?: { net_assets?: string; total_cash?: string; currency?: string }[] }>(
    creds,
    "/v1/asset/account",
    { currency },
  );
  const main = balance.list?.find((b) => b.currency === currency) ?? balance.list?.[0];
  const equity = num(main?.net_assets);
  const cash = num(main?.total_cash);

  // 持仓
  const stock = await longbridgeGet<{
    list?: { stock_info?: { symbol: string; quantity: string; cost_price?: string; currency?: string }[] }[];
  }>(creds, "/v1/asset/stock");
  const positions = (stock.list ?? [])
    .flatMap((ch) => ch.stock_info ?? [])
    .filter((p) => inMarket(p.symbol) && num(p.quantity) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      quantity: num(p.quantity),
      ...(Number.isFinite(num(p.cost_price)) ? { averageEntryPrice: num(p.cost_price) } : {}),
      assetClass: "equity",
    }));

  // 成交：历史（不含今天，按 90 天分段，最多回溯 2 年）+ 今天
  const executions = new Map<string, LbExecution>();
  const begin = startFrom(since, 730);
  for (let end = Date.now(); end > begin; end -= 90 * DAY) {
    const start = Math.max(begin, end - 90 * DAY);
    for (let page = 1; page <= 50; page++) {
      const data = await longbridgeGet<{ has_more?: boolean; trades?: LbExecution[] }>(creds, "/v1/trade/execution/history", {
        start_at: String(Math.floor(start / 1000)),
        end_at: String(Math.floor(end / 1000)),
        page: String(page),
      });
      let added = 0;
      for (const t of data.trades ?? []) if (!executions.has(t.trade_id)) (executions.set(t.trade_id, t), added++);
      if (!data.has_more || added === 0) break;
      await sleep(400);
    }
    await sleep(400);
  }
  const today = await longbridgeGet<{ trades?: LbExecution[] }>(creds, "/v1/trade/execution/today");
  for (const t of today.trades ?? []) executions.set(t.trade_id, t);

  const trades: Trade[] = [];
  for (const t of executions.values()) {
    if (!inMarket(t.symbol)) continue;
    const quantity = num(t.quantity);
    const price = num(t.price);
    const time = Number.parseInt(t.trade_done_at, 10);
    if (!(quantity > 0) || !Number.isFinite(price) || !Number.isFinite(time)) continue;
    trades.push({
      symbol: t.symbol,
      side: t.side === "Sell" ? "sell" : "buy",
      quantity,
      price,
      fee: 0, // 长桥成交接口不返回费用
      executedAt: new Date(time * 1000).toISOString(),
    });
  }

  return {
    broker: "longbridge",
    fetchedAt: new Date().toISOString(),
    accounts: [
      {
        id: "longbridge",
        name: "长桥",
        currency,
        equity: Number.isFinite(equity) ? equity : 0,
        ...(Number.isFinite(cash) ? { cash } : {}),
        positions,
        trades,
      },
    ],
  };
};

// ============================================================================ 对外接口
const LONGBRIDGE_INFO = {
  id: "longbridge",
  displayName: "长桥 Longbridge（LongPort）",
  credentials: [
    { key: "appKey", label: "App Key", secret: false },
    { key: "appSecret", label: "App Secret", secret: true },
    { key: "accessToken", label: "Access Token", secret: true },
    { key: "markets", label: "同步市场（optional，默认 US；可填 US,HK 或 ALL）", secret: false },
  ],
  readOnlySetup:
    "在长桥开发者中心（open.longbridge.com）开通 OpenAPI，进入「用户中心」获取 App Key、App Secret 和 Access Token。只读取余额、持仓和成交，不会下单。Access Token 有有效期，过期后需重新生成并更新连接。注意：长桥成交接口不提供手续费，盈亏为未扣费金额；日志账户为单一币种，默认只同步美股，混合港美股会导致金额无法比较。",
  supportsBars: false,
} as unknown as BrokerInfo;

const BYBIT_SETUP =
  "在 Bybit「API 管理」新建系统生成的 API Key，权限只勾「只读」（读取合约、现货订单与持仓）。复盘本会同步余额，以及最近 2 年的 USDT/USDC 永续和现货成交（首次同步需要几十秒）；币本位反向合约暂不支持。现货成交代码带 .SPOT 后缀，与同名永续区分。";

export const listBrokers = (): BrokerInfo[] => {
  const list = sdkListBrokers().map((b) =>
    (b.id as string) === "bybit" ? ({ ...b, readOnlySetup: BYBIT_SETUP } as BrokerInfo) : b,
  );
  return [...list, LONGBRIDGE_INFO];
};

const noBars = async (): Promise<never> => {
  throw new Error("此券商不提供历史 K 线");
};

export const connect = (options: ExtConnectOptions): Connection => {
  const credentials = { ...options.credentials };
  if (options.broker === "longbridge") {
    return {
      broker: "longbridge",
      label: "长桥",
      credentials,
      fetchSnapshot: () => fetchLongbridge(credentials, options.zhSince),
      fetchBars: noBars,
    };
  }
  const { zhSince, ...sdkOptions } = options;
  const base = sdkConnect(sdkOptions as unknown as Parameters<typeof sdkConnect>[0]) as unknown as Connection;
  if (options.broker !== "bybit") return base;
  return {
    ...base,
    broker: base.broker,
    label: base.label,
    credentials: base.credentials,
    fetchBars: base.fetchBars,
    fetchSnapshot: async () => {
      const snapshot = await base.fetchSnapshot();
      const trades = await fetchBybitTrades(credentials, zhSince);
      const [first, ...rest] = snapshot.accounts;
      return {
        ...snapshot,
        accounts: first ? [{ ...first, trades: [...first.trades, ...trades] }, ...rest] : snapshot.accounts,
      };
    },
  };
};
