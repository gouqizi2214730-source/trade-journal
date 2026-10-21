"use client";

/**
 * 数据值的中文显示（由 zh/apply.mjs 在构建时复制到 components/ 并挂到根布局）。
 *
 * 少数文字不是写在界面里，而是来自数据本身（做多/做空方向、结果标记、系统预置的
 * 笔记文件夹和例行事项阶段等）。这些值要原样保存在数据库里，不能在源码层面翻译，
 * 所以只在页面显示时，把「整段文字完全相同」的文本节点换成中文。
 * 输入框、可编辑区域、代码块里的内容不受影响。
 */
import { useEffect } from "react";

const LABELS: Record<string, string> = {
  long: "做多",
  short: "做空",
  LONG: "做多",
  SHORT: "做空",
  WIN: "盈利",
  LOSS: "亏损",
  BE: "保本",
  Sun: "周日",
  Mon: "周一",
  Tue: "周二",
  Wed: "周三",
  Thu: "周四",
  Fri: "周五",
  Sat: "周六",
  "Trade notes": "交易笔记",
  "Daily journal": "每日日志",
  "Session recaps": "交易时段回顾",
  "My notes": "我的笔记",
  "Before trading": "盘前",
  "During trading": "盘中",
  "After trading": "盘后",
  "Demo data": "演示数据",
  import: "文件导入",
  demo: "演示",
  manual: "手动",
  broker: "券商同步",
};

const SKIP = "input, textarea, select, option, script, style, code, pre, [contenteditable], .vela-root, canvas";

const translate = (node: Node) => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let n: Node | null = walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode : walker.nextNode();
  while (n) {
    const raw = n.nodeValue ?? "";
    const key = raw.trim();
    const zh = key && LABELS[key];
    if (zh && !(n.parentElement && n.parentElement.closest(SKIP))) n.nodeValue = raw.replace(key, zh);
    n = walker.nextNode();
  }
};

export function ZhDataLabels() {
  useEffect(() => {
    translate(document.body);
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") translate(r.target);
        else r.addedNodes.forEach((a) => translate(a));
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
