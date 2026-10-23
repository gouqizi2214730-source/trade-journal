"use client";
/**
 * 笔记编辑框粘贴 / 拖入图片（构建时由 zh/apply.mjs 复制到 apps/web/src/lib/zh-note-paste.ts）。
 *
 * 图片作为该笔记的附件上传（沿用 /api/attachments，存在本地数据库），
 * 并在光标处插入 Markdown 图片标记，预览时直接显示。
 */
import { useState, type ClipboardEvent, type DragEvent, type RefObject } from "react";

export type AttachTarget = { type: "trade" | "day" | "note" | "missed"; id: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SIZE = 8 * 1024 * 1024;
/** 通知页面上的附件列表刷新 */
export const ATTACHMENTS_CHANGED = "zh-attachments-changed";

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const upload = async (target: AttachTarget, file: File, index: number): Promise<string> => {
  const ext = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
  const name = file.name && file.name !== "image.png" ? file.name : `粘贴图片-${stamp()}${index ? `-${index}` : ""}.${ext}`;
  const body = new FormData();
  body.append("type", target.type);
  body.append("id", target.id);
  body.append("file", file, name);
  const res = await fetch("/api/attachments", { method: "POST", body });
  const result = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !result.id) throw new Error(result.error || "图片上传失败");
  return `![${name.replace(/[[\]]/g, "")}](/api/attachments/${result.id})`;
};

export function usePasteImages(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (value: string) => void,
  target: AttachTarget | undefined,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleFiles = async (files: File[]) => {
    if (!target || files.length === 0) return false;
    const images = files.filter((f) => IMAGE_TYPES.has(f.type));
    if (images.length === 0) return false;
    const tooBig = images.find((f) => f.size > MAX_SIZE);
    if (tooBig) {
      setError("图片不能超过 8 MB");
      return true;
    }
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    setBusy(true);
    setError("");
    try {
      const marks: string[] = [];
      for (let i = 0; i < images.length; i++) marks.push(await upload(target, images[i]!, i));
      // 上传期间用户可能继续输入：以当前文本为准，插回原光标位置
      const current = el?.value ?? value;
      const before = current.slice(0, start);
      const after = current.slice(Math.min(end, current.length));
      const lead = before && !before.endsWith("\n") ? "\n" : "";
      const insert = `${lead}${marks.join("\n")}\n`;
      onChange(before + insert + after);
      requestAnimationFrame(() => {
        ref.current?.focus();
        const pos = before.length + insert.length;
        ref.current?.setSelectionRange(pos, pos);
      });
      window.dispatchEvent(new Event(ATTACHMENTS_CHANGED));
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片上传失败");
    } finally {
      setBusy(false);
    }
    return true;
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (target && files.some((f) => IMAGE_TYPES.has(f.type))) {
      event.preventDefault();
      void handleFiles(files);
    }
  };
  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (target && files.some((f) => IMAGE_TYPES.has(f.type))) {
      event.preventDefault();
      void handleFiles(files);
    }
  };
  const onDragOver = (event: DragEvent<HTMLTextAreaElement>) => {
    if (target && Array.from(event.dataTransfer?.items ?? []).some((i) => i.kind === "file")) event.preventDefault();
  };

  const hint = !target
    ? ""
    : busy
      ? "正在上传图片…"
      : error || "可直接粘贴（Ctrl+V）或拖入截图，图片会保存为附件并插入笔记";
  return { handlers: { onPaste, onDrop, onDragOver }, hint, hintIsError: !!error && !busy };
}
