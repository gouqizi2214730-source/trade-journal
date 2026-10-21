// 把 Next.js standalone 输出组装成桌面版要打包的服务端目录。
//   desktop/server   ← apps/web/.next/standalone（符号链接展开为实际文件）+ static + public
//   desktop/node-bin ← 当前运行的 node 可执行文件（与 better-sqlite3 原生模块版本一致）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.resolve(desktop, "..", "apps", "web");
const out = path.join(desktop, "server");
const nodeBin = path.join(desktop, "node-bin");

const standalone = path.join(web, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, "apps", "web", "server.js")))
  throw new Error("找不到 apps/web/.next/standalone，请先运行 pnpm build");

// 递归复制并把符号链接展开为实际文件（fs.cpSync 的 dereference 不处理嵌套链接）
const repoRoot = path.resolve(desktop, "..");
// Windows 上 Next 生成的链接（junction）有时无法访问：按包名回到项目自己的 node_modules 找同一个包
const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const fallbackFor = (src) => {
  // standalone 目录结构与仓库一致：先找仓库里同一相对位置（pnpm 的链接在仓库里是好的）
  const rel = path.relative(standalone, src);
  if (!rel.startsWith("..")) {
    const mirrored = path.join(repoRoot, rel);
    if (exists(mirrored)) return mirrored;
  }
  const parts = src.split(/[\\/]/);
  const i = parts.lastIndexOf("node_modules");
  if (i < 0) return null;
  const pkg = parts.slice(i + 1, parts[i + 1]?.startsWith("@") ? i + 3 : i + 2).join(path.sep);
  for (const base of [path.join(web, "node_modules"), path.join(repoRoot, "node_modules")]) {
    const cand = path.join(base, pkg);
    try {
      if (fs.statSync(cand)) return cand;
    } catch {
      /* try next */
    }
  }
  return null;
};
const copyDeref = (src, dst) => {
  let st;
  try {
    st = fs.statSync(src); // stat 跟随链接
  } catch (e) {
    const alt = fallbackFor(src);
    if (!alt) throw e;
    console.log(`链接无法访问，改用 ${path.relative(repoRoot, alt)}：${path.relative(repoRoot, src)}`);
    return copyDeref(alt, dst);
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyDeref(path.join(src, name), path.join(dst, name));
  } else {
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, st.mode);
  }
};
fs.rmSync(out, { recursive: true, force: true });
copyDeref(standalone, out);
fs.cpSync(path.join(web, ".next", "static"), path.join(out, "apps", "web", ".next", "static"), { recursive: true });
fs.cpSync(path.join(web, "public"), path.join(out, "apps", "web", "public"), { recursive: true });
// 运行时数据目录不应被打包
fs.rmSync(path.join(out, "apps", "web", "data"), { recursive: true, force: true });

// electron-builder 打包 extraResources 时会丢掉最外层的 node_modules 目录。
// 把它合并进 apps/web/node_modules（server.js 从那里向上查找依赖），已存在的包以 apps/web 里的为准。
const rootModules = path.join(out, "node_modules");
const webModules = path.join(out, "apps", "web", "node_modules");
if (fs.existsSync(rootModules)) {
  fs.mkdirSync(webModules, { recursive: true });
  const merge = (src, dst) => {
    for (const name of fs.readdirSync(src)) {
      if (name === ".pnpm" || name === ".bin" || name.startsWith(".")) continue;
      const s = path.join(src, name);
      const d = path.join(dst, name);
      if (name.startsWith("@") && fs.statSync(s).isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        merge(s, d);
      } else if (!fs.existsSync(d)) fs.renameSync(s, d);
    }
  };
  merge(rootModules, webModules);
  // pnpm 默认布局：依赖在 node_modules/.pnpm/<包@版本>/node_modules/<包> 下，逐个平铺出来
  const store = path.join(rootModules, ".pnpm");
  if (fs.existsSync(store))
    for (const entry of fs.readdirSync(store)) {
      const inner = path.join(store, entry, "node_modules");
      if (fs.existsSync(inner) && fs.statSync(inner).isDirectory()) merge(inner, webModules);
    }
  fs.rmSync(rootModules, { recursive: true, force: true });
  console.log("已把外层 node_modules 合并到 apps/web/node_modules");
}

fs.rmSync(nodeBin, { recursive: true, force: true });
fs.mkdirSync(nodeBin, { recursive: true });
fs.copyFileSync(process.execPath, path.join(nodeBin, process.platform === "win32" ? "node.exe" : "node"));
if (process.platform !== "win32") fs.chmodSync(path.join(nodeBin, "node"), 0o755);

const find = (dir, name) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = find(p, name);
      if (r) return r;
    } else if (e.name === name) return p;
  }
  return null;
};
const native = find(out, "better_sqlite3.node");
if (!native) throw new Error("服务端缺少 better-sqlite3 原生模块");
let links = 0;
(function count(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isSymbolicLink()) links++;
    else if (e.isDirectory()) count(path.join(d, e.name));
  }
})(out);
if (links) throw new Error(`服务端目录仍有 ${links} 个符号链接`);
console.log(`服务端已组装：${out}\n原生模块：${path.relative(out, native)}\nNode：${process.version}`);
