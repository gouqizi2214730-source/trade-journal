"use client";
/**
 * 预设相关的小组件（构建时复制到 apps/web/src/components/zh-presets-ui.tsx）：
 * - ZhPresetPlaybooks：策略手册页一键导入 PA / VP / VWAP 策略（按名称去重）
 * - ZhQuickPick：交易详情页「标签」「错误」下方的快捷按钮，点一下加入 / 再点取消
 */
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { postJson, useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import { ZH_PLAYBOOKS } from "@/lib/zh-presets";

/** 自动打的位置 / 时段标签不放进快捷按钮 */
const AUTO_TAG = /^(位置|时段)·/;

export function ZhPresetPlaybooks({
  existing,
  onDone,
}: {
  existing: { name: string }[] | undefined;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const missing = useMemo(() => {
    const have = new Set((existing ?? []).map((p) => p.name.trim()));
    return ZH_PLAYBOOKS.filter((p) => !have.has(p.name));
  }, [existing]);
  if (!existing || missing.length === 0) return null;
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      for (const p of missing) await postJson("/api/playbooks", p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={run}
        title={missing.map((p) => p.name).join("、")}
      >
        <Download />
        {busy ? "正在导入…" : `导入 PA / VP / VWAP 策略（${missing.length}）`}
      </Button>
    </>
  );
}

const split = (value: string) =>
  value
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function ZhQuickPick({
  options,
  field,
  value,
  onChange,
}: {
  options: string[];
  /** 从已有交易里补充常用项 */
  field: "tags" | "mistakes";
  value: string;
  onChange: (next: string) => void;
}) {
  const { data } = useApi<{ trades: { tags: string[]; mistakes: string[] }[] }>("/api/trades?view=list");
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of data?.trades ?? [])
      for (const s of t[field] ?? [])
        if (!AUTO_TAG.test(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
    const own = [...counts.entries()]
      .filter(([s]) => !options.includes(s))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([s]) => s);
    return [...options, ...own];
  }, [data, field, options]);
  const current = split(value);
  const toggle = (chip: string) => {
    const next = current.includes(chip) ? current.filter((s) => s !== chip) : [...current, chip];
    onChange(next.join(", "));
  };
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {chips.map((chip) => {
        const on = current.includes(chip);
        return (
          <button
            key={chip}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(chip)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs transition-colors",
              on
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {chip}
          </button>
        );
      })}
    </div>
  );
}
