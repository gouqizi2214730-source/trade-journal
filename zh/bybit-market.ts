/**
 * Bybit 公开 K 线行情源（构建时复制到 apps/web/src/server/market-data/zh-bybit.ts）。
 * 交易详情页「行情数据与回放」可以直接用 Bybit 的 K 线回放、估算 MAE/MFE，
 * 包括 Bybit 独有的股票永续（MUUSDT、INTCUSDT 等）。无需 API 密钥。
 * 界面上的说明文字在 zh/apply.mjs 里补进 lib/market-providers.ts（那个文件也会被浏览器端引用）。
 */
import { MarketDataError, type MarketDataProvider } from "./provider";
import { array, number, readJson, record, result, validateBars, windows } from "./http";

const BYBIT = "https://api.bybit.com";
const INTERVAL = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "1d": "D" } as const;

export const bybitKline: MarketDataProvider = {
  id: "bybit",
  name: "Bybit",
  environmentKey: "",
  async test() {
    await readJson(`${BYBIT}/v5/market/time`, {}, undefined, { cache: false });
  },
  async history(request) {
    const spot = request.symbol.endsWith(".SPOT");
    const symbol = spot ? request.symbol.slice(0, -5) : request.symbol;
    if (!/^[A-Z0-9-]{3,40}$/.test(symbol))
      throw new MarketDataError("请使用 Bybit 代码，例如 BTCUSDT（现货加 .SPOT 后缀）。");
    if (request.dataset) throw new MarketDataError("Bybit 不需要选择数据集，请留空。");
    const history = await windows(request, 999, async (from, to, signal) => {
      const query = new URLSearchParams({
        category: spot ? "spot" : "linear",
        symbol,
        interval: INTERVAL[request.resolution],
        start: String(from),
        end: String(to - 1),
        limit: "1000",
      });
      const body = record(await readJson(`${BYBIT}/v5/market/kline?${query}`, {}, signal));
      if (body.retCode !== 0)
        throw new MarketDataError(
          /symbol/i.test(String(body.retMsg)) ? `Bybit 没有 ${request.symbol} 这个品种。` : `Bybit：${String(body.retMsg ?? body.retCode)}`,
        );
      return validateBars(
        array(record(body.result).list).map((item) => {
          const row = array(item);
          return {
            time: number(row[0]),
            open: number(row[1]),
            high: number(row[2]),
            low: number(row[3]),
            close: number(row[4]),
            volume: number(row[5]),
          };
        }),
      );
    });
    // 不声明计价币：Bybit 成交本身就以 USDT/USDC 记账，K 线与成交同一单位
    return result(this.name, request, history.bars, history.truncated, [
      "Bybit 成交价 K 线，按 UTC 对齐；没有成交的时段可能缺 K 线，不会补造价格。",
    ]);
  },
};
