"use client";
/**
 * 长桥 OAuth 授权按钮（构建时复制到 apps/web/src/components/zh-longbridge-ui.tsx）
 * - ZhLongbridgeOAuth：「导入 → 连接券商」选长桥时显示，授权完成后才能点「连接并同步」
 * - ZhLongbridgeReauth：「账户」页长桥账户卡片上的「重新授权」
 */
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/use-api";

type Phase = "idle" | "waiting" | "done" | "error";

function useLongbridgeAuth(onDone: (ref: string) => Promise<void> | void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const start = async (accountId?: string) => {
    stop();
    setError("");
    setPhase("waiting");
    try {
      const r = await postJson<{ url: string; state: string }>("/api/zh-longbridge", { action: "start", accountId });
      setUrl(r.url);
      window.open(r.url, "_blank", "noopener");
      const began = Date.now();
      timer.current = setInterval(async () => {
        if (Date.now() - began > 10 * 60_000) {
          stop();
          setPhase("error");
          setError("等待授权超时，请重新点击授权");
          return;
        }
        try {
          const res = await fetch(`/api/zh-longbridge?status=${encodeURIComponent(r.state)}`);
          const s = (await res.json()) as { status: string; ref?: string; error?: string };
          if (s.status === "done" && s.ref) {
            stop();
            await onDone(s.ref);
            setPhase("done");
          } else if (s.status === "error") {
            stop();
            setPhase("error");
            setError(s.error || "长桥授权失败");
          }
        } catch {
          /* 网络抖动，下次再查 */
        }
      }, 2000);
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "无法开始授权");
    }
  };
  return { phase, error, url, start };
}

export function ZhLongbridgeOAuth({ value, onAuthorized }: { value: string; onAuthorized: (ref: string) => void }) {
  const auth = useLongbridgeAuth(onAuthorized);
  const done = Boolean(value) || auth.phase === "done";
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={done ? "outline" : "default"}
          disabled={auth.phase === "waiting"}
          onClick={() => void auth.start()}
        >
          <KeyRound />
          {done ? "重新授权" : auth.phase === "waiting" ? "等待浏览器中完成授权…" : "在浏览器中授权"}
        </Button>
        {done && (
          <span className="flex items-center gap-1 text-sm text-profit">
            <CheckCircle2 className="h-4 w-4" />
            已授权，可以点下面「连接并同步」
          </span>
        )}
      </div>
      {auth.phase === "waiting" && auth.url && (
        <p className="text-xs text-muted-foreground">
          浏览器没有自动打开？
          <a className="ml-1 inline-flex items-center gap-0.5 underline" href={auth.url} target="_blank" rel="noreferrer">
            点这里打开长桥授权页 <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      )}
      {auth.error && (
        <p role="alert" className="text-xs text-loss">
          {auth.error}
        </p>
      )}
    </div>
  );
}

export function ZhLongbridgeReauth({ accountId, onDone }: { accountId: string; onDone?: () => void }) {
  const auth = useLongbridgeAuth(async (ref) => {
    await postJson("/api/zh-longbridge", { action: "bind", accountId, ref });
    onDone?.();
  });
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs"
        disabled={auth.phase === "waiting"}
        title={auth.error || "用长桥账号重新授权（授权失效或缺少权限时使用）"}
        onClick={() => void auth.start(accountId)}
      >
        <KeyRound />
        {auth.phase === "waiting" ? "等待授权…" : auth.phase === "done" ? "已重新授权" : "重新授权"}
      </Button>
      {auth.phase === "error" && <span className="text-xs text-loss">{auth.error}</span>}
    </>
  );
}
