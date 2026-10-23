#!/usr/bin/env node
/**
 * 构建时简体中文本地化（Build-time Simplified Chinese localization）
 *
 * 不改动上游源码：构建前运行本脚本，按 zh/zh-CN.json 词典把界面文字替换成中文，
 * 因此合并 LuxAlgo 上游更新时不会产生冲突。新增的英文文字在词典补上之前保持英文。
 *
 *   node zh/apply.mjs            套用汉化（就地改写 apps/web/src，仅用于构建）
 *   node zh/apply.mjs --extract  只扫描，输出 zh/untranslated.json（未翻译的界面文字）
 *
 * 安全规则：只替换界面位置的文字（JSX 文本、label/title/placeholder 等属性、
 * toast/错误提示等），被代码拿来比较、当键名或当类型用的字符串一律跳过。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const require = createRequire(path.join(repo, "package.json"));
const ts = require("typescript");

const EXTRACT = process.argv.includes("--extract");
const SRC_ROOTS = ["apps/web/src"].map((p) => path.join(repo, p));
const SAFETY_ROOTS = ["apps/web/src", "packages"].map((p) => path.join(repo, p));
const dict = JSON.parse(fs.readFileSync(path.join(here, "zh-CN.json"), "utf8"));

// ---------------------------------------------------------------- files
const listFiles = (dir) => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (["node_modules", "tests", "__tests__", "dist", ".next"].includes(f)) continue;
      out.push(...listFiles(p));
    } else if (/\.(tsx?|mts)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith(".d.ts") && !f.startsWith("zh-")) {
      out.push(p);
    }
  }
  return out;
};
const parse = (file) =>
  ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const norm = (s) => s.replace(/\s+/g, " ").trim();
const isStr = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

// ---------------------------------------------------------------- data-like literals
// 被当成数据值的字符串（value/id/kind 等字段、类型字面量、startsWith/includes 参数）
// 一律不翻译；只在 packages/ 里被比较过的字符串，apps 中的比较/分支也不翻译。
// apps 内部一致使用的显示文字（包括 label === "…" 比较、以文字为键的查找表）会整体翻译，逻辑保持一致。
const CMP = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const LOOKUP = new Set(["includes", "startsWith", "endsWith", "indexOf", "has", "test", "match", "search", "replace", "split"]);
const DATA_PROP = /^(value|id|key|kind|type|code|status|variant|side|slug|format|provider|source|unit|mode)$/;
const DENY = new Set(JSON.parse(fs.readFileSync(path.join(here, "deny.json"), "utf8")));
const appsData = new Set(DENY);
const pkgCompared = new Set();
const isCompared = (n, p) =>
  (ts.isBinaryExpression(p) && CMP.has(p.operatorToken.kind)) ||
  ts.isCaseClause(p) ||
  ts.isElementAccessExpression(p) ||
  (ts.isPropertyAssignment(p) && p.name === n);
const isLabelMap = (o) =>
  ts.isObjectLiteralExpression(o) &&
  o.properties.length >= 3 &&
  o.properties.every((q) => ts.isPropertyAssignment(q) && isStr(q.initializer) && /^[A-Z]|\s/.test(q.initializer.text));
const isData = (n, p) =>
  (ts.isArrayLiteralExpression(p) &&
    ts.isPropertyAccessExpression(p.parent) &&
    LOOKUP.has(p.parent.name.text)) ||
  ts.isLiteralTypeNode(p) ||
  ts.isEnumMember(p) ||
  (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && LOOKUP.has(p.expression.name.text)) ||
  (ts.isPropertyAssignment(p) && p.initializer === n && DATA_PROP.test(propName(p.name)) && !isLabelMap(p.parent)) ||
  (ts.isJsxAttribute(p) && DATA_PROP.test(propName(p.name)));
const propName = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : n ? n.getText() : "");
for (const f of listFiles(path.join(repo, "packages")))
  (function visit(n) {
    if (isStr(n) && (isCompared(n, n.parent) || isData(n, n.parent))) pkgCompared.add(norm(n.text));
    ts.forEachChild(n, visit);
  })(parse(f));
for (const root of SRC_ROOTS)
  for (const f of listFiles(root))
    (function visit(n) {
      if (isStr(n) && isData(n, n.parent)) appsData.add(norm(n.text));
      ts.forEachChild(n, visit);
    })(parse(f));

// ---------------------------------------------------------------- UI contexts
const UI_NAME =
  /^(header|name|question|prompt|placeholderText|label|title|description|placeholder|alt|aria-label|aria-description|aria-valuetext|tooltip|hint|help|helper|helpText|heading|subtitle|caption|summary|message|error|warning|notice|empty|emptyText|emptyLabel|emptyMessage|text|detail|details|note|reason|explanation|cta|action|actionLabel|confirmLabel|cancelLabel|submitLabel|short|long|blurb|tagline)$|(Label|Title|Text|Description|Placeholder|Message|Hint|Heading|Caption|Tooltip|Help|Summary|Note|Error|Warning|Notice)$/;
const UI_CALL = /^(toast(\.\w+)?|setError|setMessage|setStatus|setNotice|setWarning|setInfo|setFeedback|setHint|alert|confirm|notify|showError|showToast|fail|report)$/;
const UI_HELPER = /^(input|select|field|numberField|textField|dateField|stat|metric|row|col|column|header|section|card|option|tab|chip|toggle|checkbox|check|money|pct|line|kv|pair)$/i;
const UI_VAR = /(label|title|message|text|description|placeholder|hint|heading|summary|caption|tooltip|notice|warning|error)s?$/i;

/** 返回字符串所处的界面上下文；不是界面文字则返回 null。 */
const uiContext = (node) => {
  let n = node;
  let p = n.parent;
  for (;;) {
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression?.(p)) {
      n = p;
      p = p.parent;
      continue;
    }
    if (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) {
      n = p;
      p = p.parent;
      continue;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.right === n &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(
        p.operatorToken.kind,
      )
    ) {
      n = p;
      p = p.parent;
      continue;
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      n = p;
      p = p.parent;
      continue;
    }
    break;
  }
  if (ts.isJsxExpression(p)) {
    const a = p.parent;
    if (ts.isJsxAttribute(a)) return UI_NAME.test(propName(a.name)) ? "attr" : null;
    return "jsx";
  }
  if (ts.isJsxAttribute(p)) return UI_NAME.test(propName(p.name)) ? "attr" : null;
  if (ts.isPropertyAssignment(p) && p.initializer === n) {
    if (UI_NAME.test(propName(p.name)) || ts.isStringLiteral(p.name)) return "prop";
    // 文字标签映射表：{ winRate: "Win %", profitFactor: "Profit factor", … }
    const o = p.parent;
    if (isLabelMap(o)) return "map";
    return null;
  }
  // 以显示文字为键的查找表（"Net P&L": Icon）：键随文字一起翻译
  if (ts.isPropertyAssignment(p) && p.name === node) return "key";
  if ((ts.isBinaryExpression(p) && CMP.has(p.operatorToken.kind)) || ts.isCaseClause(p)) return "cmp";
  if (ts.isVariableDeclaration(p) && p.initializer === n) return UI_VAR.test(p.name.getText()) ? "var" : null;
  if (ts.isNewExpression(p) && /Error$/.test(p.expression.getText())) return "error";
  if (ts.isCallExpression(p) && p.arguments.includes(n) && UI_CALL.test(p.expression.getText())) return "call";
  // 本地表单/表格辅助函数的显示参数：input("symbol", "Symbols")、select("reviewed", "Review status", …)
  if (ts.isCallExpression(p) && p.arguments.indexOf(n) > 0 && UI_HELPER.test(p.expression.getText())) return "call";
  // 全是显示文字的数组：["Sun", "Mon", …]、示例问题列表
  if (
    ts.isArrayLiteralExpression(p) &&
    p.elements.length >= 2 &&
    p.elements.every((e) => isStr(e) && /^[A-Z]/.test(e.text) && /[a-z]/.test(e.text)) &&
    // 只处理直接渲染（[…].map(…)）或名字表明是展示用的数组；用于 indexOf 排序等的数组不动
    ((ts.isPropertyAccessExpression(p.parent) && p.parent.name.text === "map") ||
      (ts.isVariableDeclaration(p.parent) && /suggest|question|example|prompt|hint|tip|label|title/i.test(p.parent.name.getText())))
  )
    return "list";
  // [id, 显示文字] 元组：["duration", "Minutes held"]、["Net P&L", value]
  if (ts.isArrayLiteralExpression(p) && p.elements.length >= 2 && p.elements.length <= 4) {
    const i = p.elements.indexOf(n);
    const first = p.elements[0];
    if (i === 1 && isStr(first) && /^[a-z][A-Za-z0-9_.-]*$/.test(first.text)) return "tuple";
    if (i === 0 && /[A-Z ]/.test(n.text) && ts.isArrayLiteralExpression(p.parent)) return "tuple";
  }
  if (ts.isReturnStatement(p)) {
    // return "…" inside a function whose name looks like a label/description helper
    let f = p.parent;
    while (f && !ts.isFunctionLike(f)) f = f.parent;
    const name = f?.name?.getText?.() ?? (f && ts.isVariableDeclaration(f.parent) ? f.parent.name.getText() : "");
    if (/(label|title|message|text|description|hint|summary|caption|describe|explain|format\w*Label)/i.test(name)) return "return";
  }
  return null;
};

// template literal → key with {0},{1}…
const templateKey = (t) => {
  let k = t.head.text;
  t.templateSpans.forEach((s, i) => (k += `{${i}}` + s.literal.text));
  return norm(k);
};
const escTpl = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
const buildTemplate = (t, zh, src) => {
  const exprs = t.templateSpans.map((s) => s.expression.getText(src));
  const parts = zh.split(/\{(\d+)\}/);
  let out = "`";
  parts.forEach((part, i) => {
    if (i % 2 === 0) out += escTpl(part);
    else out += "${" + exprs[Number(part)] + "}";
  });
  return out + "`";
};
const hasLetters = (s) => /[A-Za-z]{2}/.test(s);
const looksTechnical = (s) =>
  /^[a-z0-9_.\-/:]+$/.test(s) || /^https?:/.test(s) || /^[A-Z0-9_]+$/.test(s) || /^\W*$/.test(s) || /^[.#]?[a-z-]+\s*[:{]/.test(s);

// ---------------------------------------------------------------- run
const missing = new Map();

const note = (key, ctx, file) => {
  if (!missing.has(key)) missing.set(key, { ctx, file: path.relative(repo, file), n: 0 });
  missing.get(key).n++;
};
let replaced = 0;
let touched = 0;

for (const root of SRC_ROOTS)
  for (const file of listFiles(root)) {
    const src = parse(file);
    const text = src.getFullText();
    const edits = [];
    (function visit(n) {
      if (ts.isJsxText(n)) {
        const raw = n.getFullText(src);
        const key = norm(raw);
        if (key && hasLetters(key) && !/^[A-Z0-9_]+$/.test(key) && !/^https?:/.test(key)) {
          const zh = dict[`${path.relative(repo, file)}::${key}`] ?? dict[key];
          if (zh && zh !== key) {
            const lead = raw.match(/^\s*/)[0];
            const trail = raw.match(/\s*$/)[0];
            const body = /[{}<>]/.test(zh) ? `{${JSON.stringify(zh)}}` : zh;
            // keep a single separating space only when the source had one on the same line
            const l = lead.includes("\n") ? lead : lead;
            const r = trail.includes("\n") ? trail : trail;
            edits.push([n.getFullStart(), n.getEnd(), l + body + r]);
          } else if (!zh) note(key, "jsx", file);
        }
      } else if (isStr(n) || ts.isTemplateExpression(n)) {
        const key = ts.isTemplateExpression(n) ? templateKey(n) : norm(n.text);
        const jsxDirect = uiContext(n) === "jsx";
        if (key && hasLetters(key) && (jsxDirect ? !/^[A-Z0-9_]+$/.test(key) : !looksTechnical(key)) && !appsData.has(key)) {
          let ctx = uiContext(n);
          if (ctx === "cmp" && pkgCompared.has(key)) ctx = null;
          if (ctx) {
            const rel = path.relative(repo, file);
            const zh = DENY.has(`${rel}::${key}`) ? key : (dict[`${rel}::${key}`] ?? dict[key]);
            if (zh && zh !== key) {
              const start = n.getStart(src);
              const repl = ts.isTemplateExpression(n) ? buildTemplate(n, zh, src) : JSON.stringify(zh);
              // a bare string attribute (label="x") must stay attribute-safe
              const wrap = ts.isJsxAttribute(n.parent) ? `{${repl}}` : repl;
              edits.push([start, n.getEnd(), wrap]);
            } else if (!zh) note(key, ctx, file);
          }
        }
        if (ts.isTemplateExpression(n)) n.templateSpans.forEach((s) => visit(s.expression));
        return;
      }
      ts.forEachChild(n, visit);
    })(src);
    if (!EXTRACT && edits.length) {
      edits.sort((a, b) => b[0] - a[0]);
      let out = text;
      for (const [s, e, r] of edits) out = out.slice(0, s) + r + out.slice(e);
      fs.writeFileSync(file, out);
      replaced += edits.length;
      touched++;
    }
  }

// ---------------------------------------------------------------- targeted patches
const patches = [
  // AI 复盘、点评、问答默认用简体中文回答
  {
    file: "apps/web/src/server/ai.ts",
    find: /const SYSTEM = `([\s\S]*?)`;/,
    replace: (_m, body) =>
      "const SYSTEM = `" + body + "\nAlways write your answer in Simplified Chinese (简体中文), using the trading terms Chinese traders use (盈亏、胜率、盈亏比、回撤、止损、仓位). Keep tickers, numbers and currency symbols as given.`;",
  },
  { file: "apps/web/src/app/layout.tsx", find: /<html lang="en"/, replace: () => '<html lang="zh-CN"' },
  {
    file: "apps/web/src/app/layout.tsx",
    find: /title: "Trade Journal",/,
    replace: () => 'title: "复盘本",',
    optional: true,
  },
];
// 日期、星期、月份显示成中文（金额格式保持 en-US，避免变成 US$）
for (const f of listFiles(path.join(repo, "apps/web/src"))) {
  const rel = path.relative(repo, f);
  if (rel.includes("/server/")) continue;
  patches.push({ file: rel, find: /DateTimeFormat\("en-US"/g, replace: () => 'DateTimeFormat("zh-CN"', optional: true });
  patches.push({
    file: rel,
    find: /toLocale(Date|Time)?String\(\s*"en-US"/g,
    replace: (_m, k) => `toLocale${k ?? ""}String("zh-CN"`,
    optional: true,
  });
}
patches.push({
  file: "apps/web/src/components/prop-firm-tracker.tsx",
  find: /: label\(v\)\}/,
  replace: () => ': (({ overview: "概览", accounts: "账户", payouts: "出金" }) as Record<string, string>)[v] ?? label(v)}',
  optional: true,
});
patches.push({ file: "apps/web/src/lib/currencies.ts", find: /DisplayNames\("en"/, replace: () => 'DisplayNames("zh-CN"', optional: true });
for (const f of listFiles(path.join(repo, "apps/web/src"))) {
  const rel = path.relative(repo, f);
  if (rel.includes("/server/")) continue;
  patches.push({ file: rel, find: /DateTimeFormat\(undefined/g, replace: () => 'DateTimeFormat("zh-CN"', optional: true });
  patches.push({ file: rel, find: /toLocale(Date|Time)?String\(undefined/g, replace: (_m, k) => `toLocale${k ?? ""}String("zh-CN"`, optional: true });
}
if (!EXTRACT) {
  // 衍生版本不得使用 LuxAlgo 名称和标志（见 TRADEMARKS.md），换成复盘本自己的标志
  fs.copyFileSync(path.join(here, "brand-mark.tsx"), path.join(repo, "apps/web/src/components/luxalgo-mark.tsx"));
}
if (!EXTRACT)
  fs.copyFileSync(path.join(here, "zh-data-labels.tsx"), path.join(repo, "apps/web/src/components/zh-data-labels.tsx"));
patches.push(
  {
    file: "apps/web/src/app/layout.tsx",
    find: /import "\.\/globals\.css";/,
    replace: (m) => m + '\nimport { ZhDataLabels } from "@/components/zh-data-labels";',
    skipIf: "ZhDataLabels",
  },
  {
    file: "apps/web/src/app/layout.tsx",
    find: /(<body[^>]*>)/,
    replace: (m) => m + "\n        <ZhDataLabels />",
    skipIf: "<ZhDataLabels />",
  },
);
// 券商扩展：Bybit 成交同步 + 长桥（见 zh/brokers-ext.ts）。上游改动导致补丁失效时让构建失败，避免悄悄丢功能。
if (!EXTRACT)
  fs.copyFileSync(path.join(here, "brokers-ext.ts"), path.join(repo, "apps/web/src/server/zh-brokers.ts"));
const SYNC = "apps/web/src/server/sync.ts";
patches.push(
  {
    file: SYNC,
    find: /import \{ connect, listBrokers, type BrokerId \} from "@luxalgo\/broker-sdk";/,
    replace: () => 'import { type BrokerId } from "@luxalgo/broker-sdk";\nimport { connect, listBrokers } from "./zh-brokers";',
    required: true,
    skipIf: "./zh-brokers",
  },
  {
    file: SYNC,
    find: /import \{ eq \} from "drizzle-orm";/,
    replace: () => 'import { and, desc, eq } from "drizzle-orm";',
    required: true,
    skipIf: "import { and, desc, eq }",
  },
  {
    file: SYNC,
    find: /import \{ accounts, db \} from "@\/db";/,
    replace: () => 'import { accounts, db, executions } from "@/db";',
    required: true,
    skipIf: "accounts, db, executions",
  },
  {
    file: SYNC,
    find: /(\n\s*)const connection = connect\(\{/,
    replace: (_m, ws) =>
      `${ws}// 复盘本：从该账户已同步的最新一笔成交往前补拉；没有成交则回溯券商允许的最长历史` +
      `${ws}const zhLatest = db.select({ t: executions.executedAt }).from(executions)` +
      `${ws}  .where(and(eq(executions.accountId, accountId), eq(executions.source, "sync")))` +
      `${ws}  .orderBy(desc(executions.executedAt)).limit(1).get();` +
      `${ws}const connection = connect({${ws}  zhSince: zhLatest?.t ?? null,`,
    required: true,
    skipIf: "zhSince:",
  },
);
// 笔记粘贴图片（见 zh/note-paste.ts）
if (!EXTRACT) fs.copyFileSync(path.join(here, "note-paste.ts"), path.join(repo, "apps/web/src/lib/zh-note-paste.ts"));
const RE = "apps/web/src/components/rich-editor.tsx";
const ATT = "apps/web/src/components/attachments.tsx";
patches.push(
  { file: RE, find: /(import \{ tradeLinkLabel[^\n]*\n)/, replace: (m) => m + 'import { usePasteImages, type AttachTarget } from "@/lib/zh-note-paste";\n', required: true, skipIf: "zh-note-paste" },
  { file: RE, find: /(\n  editorRef,\n\}: \{)/, replace: () => "\n  editorRef,\n  attachTo,\n}: {", required: true, skipIf: "  attachTo,\n" },
  { file: RE, find: /(\n  editorRef\?: Ref<RichEditorHandle>;\n)/, replace: (m) => m + "  attachTo?: AttachTarget;\n", required: true, skipIf: "attachTo?: AttachTarget" },
  {
    file: RE,
    find: /(const preview = mode \? mode === "preview" : localPreview;)/,
    replace: (m) => m + "\n  const zhPaste = usePasteImages(ref, value, onChange, attachTo);",
    required: true,
    skipIf: "zhPaste = usePasteImages",
  },
  {
    file: RE,
    find: /(onChange=\{\(e\) => onChange\(e\.target\.value\)\}\n(\s*)placeholder=\{placeholder\}\n)/,
    replace: (m, _all, ind) => `${m}${ind}{...zhPaste.handlers}\n`,
    required: true,
    skipIf: "zhPaste.handlers",
  },
  {
    file: RE,
    find: /(\n(\s*)\{error && \(\n\s*<p role="alert" className="text-xs text-destructive">\n\s*\{error\}\n\s*<\/p>\n\s*\)\}\n\s*<\/div>\n\s*\);\n\}\s*$)/,
    replace: (m, _all, ind) =>
      `\n${ind}{!preview && zhPaste.hint && (\n${ind}  <p className={\`text-xs \${zhPaste.hintIsError ? "text-destructive" : "text-muted-foreground"}\`}>{zhPaste.hint}</p>\n${ind})}` + m,
    required: true,
    skipIf: "zhPaste.hint &&",
  },
  { file: ATT, find: /import \{ useRef, useState \} from "react";/, replace: () => 'import { useEffect, useRef, useState } from "react";\nimport { ATTACHMENTS_CHANGED } from "@/lib/zh-note-paste";', required: true, skipIf: "ATTACHMENTS_CHANGED" },
  {
    file: ATT,
    find: /(const input = useRef<HTMLInputElement>\(null\);)/,
    replace: (m) => m + "\n  useEffect(() => {\n    window.addEventListener(ATTACHMENTS_CHANGED, refresh);\n    return () => window.removeEventListener(ATTACHMENTS_CHANGED, refresh);\n  }, [refresh]);",
    required: true,
    skipIf: "addEventListener(ATTACHMENTS_CHANGED",
  },
  { file: "apps/web/src/app/notebook/page.tsx", find: /<RichEditor\n(\s*)editorRef=\{editor\}/, replace: (m, ind) => `${m}\n${ind}attachTo={{ type: "note", id: note.id }}`, required: true, skipIf: 'type: "note", id: note.id' },
  { file: "apps/web/src/app/journal/[date]/page.tsx", find: /<RichEditor editorRef=\{noteEditor\}/, replace: (m) => `${m} attachTo={{ type: "day", id: date }}`, required: true, skipIf: 'type: "day", id: date' },
  { file: "apps/web/src/app/trades/[key]/page.tsx", find: /<RichEditor\n(\s*)editorRef=\{noteEditor\}/, replace: (m, ind) => `${m}\n${ind}attachTo={{ type: "trade", id: trade.key }}`, required: true, skipIf: 'type: "trade", id: trade.key' },
  {
    file: "apps/web/src/app/globals.css",
    find: /$/,
    replace: () => "\n/* 复盘本：笔记中的图片 */\n.journal-markdown img { max-width: 100%; height: auto; border-radius: 6px; margin: 0.5rem 0; }\n",
    required: true,
    skipIf: "复盘本：笔记中的图片",
  },
);
let patched = 0;
const missed = [];
if (!EXTRACT)
  for (const p of patches) {
    const f = path.join(repo, p.file);
    if (!fs.existsSync(f)) continue;
    // Windows 构建机检出的是 CRLF 换行，统一成 LF 再匹配（补丁规则按 LF 编写）
    const before = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    if (p.skipIf && before.includes(p.skipIf)) continue;
    const after = before.replace(p.find, p.replace);
    if (after !== before) {
      fs.writeFileSync(f, after);
      patched++;
    } else if (p.required) missed.push(`${p.file} ${p.find}`);
    else if (!p.optional) console.warn(`[zh] 补丁未命中（上游可能已改动）：${p.file} ${p.find}`);
  }

const list = [...missing.entries()]
  .sort((a, b) => b[1].n - a[1].n)
  .map(([k, v]) => ({ en: k, ctx: v.ctx, file: v.file, n: v.n }));
fs.writeFileSync(path.join(here, "untranslated.json"), JSON.stringify(list, null, 1) + "\n");

const total = Object.keys(dict).length;
console.log(
  EXTRACT
    ? `[zh] 扫描完成：词典 ${total} 条，未翻译界面文字 ${list.length} 条 → zh/untranslated.json`
    : `[zh] 已汉化 ${touched} 个文件、${replaced} 处文字，补丁 ${patched} 处；仍未翻译 ${list.length} 条（见 zh/untranslated.json）`,
);
if (missed.length) {
  console.error(`[zh] 必需的补丁未命中（上游代码可能已改动），需要更新 zh/apply.mjs：\n  ${missed.join("\n  ")}`);
  process.exit(1);
}
