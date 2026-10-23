"use client";
/**
 * 交易详情页「入场位置（自动）」卡片（构建时复制到 apps/web/src/components/zh-location-ui.tsx）。
 * 自动标签（位置·… / 时段·…）在这里显示，不混进手动输入的标签框。
 */
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePrivacy } from "@/components/privacy";
import { postJson, useApi } from "@/lib/use-api";

export const ZH_AUTO_TAG = /^(位置|时段)·/;

/** 手动标签框保存时，把已有的自动标签带上，避免被覆盖 */
export const zhWithAuto = (own: string[], tagsJson: string | null) => [
  ...own.filter((t) => !ZH_AUTO_TAG.test(t)),
  ...(JSON.parse(tagsJson ?? "[]") as string[]).filter((t) => ZH_AUTO_TAG.test(t)),
];
export const zhOwnTags = (tagsJson: string | null) =>
  (JSON.parse(tagsJson ?? "[]") as string[]).filter((t) => !ZH_AUTO_TAG.test(t));
/** 自动标签变化时让「记录这笔交易」卡片重新读取标签 */
export const zhAutoKey = (key: string, tagsJson: string | null) =>
  `${key}|${(JSON.parse(tagsJson ?? "[]") as string[]).filter((t) => ZH_AUTO_TAG.test(t)).join(",")}`;

type Levels = Record<
  "pdh" | "pdl" | "pdc" | "poc" | "vah" | "val" | "open" | "asiaHigh" | "asiaLow" | "vwap" | "sigma" | "vwapSlope" | "atr",
  number | null
>;
interface Context {
  entryAt: string;
  entry: number;
  direction: "long" | "short";
  computedAt: string;
  levels: Levels | null;
  tags: string[];
  notes: string[];
}

const fmt = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "–" : n.toLocaleString("en-US", { maximumSignificantDigits: 6 });

export function ZhLocationCard({ tradeKey, onUpdated }: { tradeKey: string; onUpdated: () => void }) {
  const { data, refresh } = useApi<{ eligible: boolean; context: Context | null }>(
    `/api/zh-location?key=${encodeURIComponent(tradeKey)}`,
  );
  const hidden = usePrivacy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!data?.eligible) return null;
  const c = data.context;
  const L = c?.levels;
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await postJson("/api/zh-location", { key: tradeKey });
      refresh();
      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "计算失败");
    } finally {
      setBusy(false);
    }
  };
  const price = (n: number | null | undefined) => (hidden ? "••••" : fmt(n));
  const z = L?.vwap != null && L.sigma && c ? (c.entry - L.vwap) / L.sigma : null;
  const rows: [string, string][] = L
    ? [
        ["入场价（首笔成交）", price(c!.entry)],
        [
          "当日 VWAP",
          L.vwap == null ? "–" : `${price(L.vwap)}（入场 ${z! >= 0 ? "+" : ""}${z!.toFixed(2)}σ）`,
        ],
        [
          "VWAP 斜率（近 1 小时）",
          L.vwapSlope == null
            ? "–"
            : `${L.vwapSlope > 0 ? "向上" : L.vwapSlope < 0 ? "向下" : "走平"} ${L.vwapSlope >= 0 ? "+" : ""}${L.vwapSlope.toFixed(2)}σ`,
        ],
        ["前日 VAH / POC / VAL", `${price(L.vah)} / ${price(L.poc)} / ${price(L.val)}`],
        ["前日 高 / 低 / 收", `${price(L.pdh)} / ${price(L.pdl)} / ${price(L.pdc)}`],
        ["当日开盘价", price(L.open)],
        ["亚盘 高 / 低", `${price(L.asiaHigh)} / ${price(L.asiaLow)}`],
        ["5 分钟平均波幅", price(L.atr)],
      ]
    : [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>入场位置（自动）</CardTitle>
        <Button variant="ghost" size="sm" disabled={busy} onClick={run}>
          <RefreshCw className={busy ? "animate-spin" : undefined} />
          {c ? "重新计算" : "计算"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!c && !busy && (
          <p className="text-muted-foreground">
            还没计算。桌面版同步后会自动补上，也可以点「计算」。
          </p>
        )}
        {c && c.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {c.tags.map((t) => (
              <Badge key={t} variant="secondary" className="font-normal">
                {t.replace(ZH_AUTO_TAG, "")}
              </Badge>
            ))}
          </div>
        )}
        {rows.length > 0 && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {c?.notes.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          用 Bybit 公开 5 分钟 K 线、只用入场前已收盘的 K 线计算；按 UTC 日划分（北京时间 08:00 换日）。标签会进「报告 → 按标签」统计胜率。
        </p>
      </CardContent>
    </Card>
  );
}
