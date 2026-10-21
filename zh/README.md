# 复盘本 · 交易日志中文桌面版

这个仓库是 [LuxAlgo/trade-journal](https://github.com/LuxAlgo/trade-journal) 的非官方中文分支，桌面版名为「复盘本」，加了两样东西：

- **简体中文界面**：约 1,500 条界面文字、AI 复盘默认中文回答、日期按中文显示。
- **Windows 安装包 + 自动更新**：在 [Releases](../../releases) 下载 `FupanBook-Setup-x.y.z.exe`，安装后会自动从本仓库检查更新。

## 安装

1. 打开 [Releases](../../releases)，下载最新的 `FupanBook-Setup-*.exe`。
2. 双击安装。安装包没有代码签名，Windows 可能提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
3. 桌面上会出现「复盘本」快捷方式。

数据保存在 `%APPDATA%\FupanBook\data`（菜单「文件 → 打开数据文件夹」），卸载和更新都不会删除。备份时复制整个文件夹即可。

## 自动更新怎么运作

```
LuxAlgo 上游更新 ──每天 09:17 自动合并──▶ 本仓库 main
                                          │
                     GitHub Actions（Windows）构建 → 套用汉化 → 打包 exe
                                          │
                                   发布到本仓库 Releases
                                          │
                已安装的桌面版每 6 小时检查一次 → 后台下载 → 提示重启安装
```

也可以在桌面版菜单「帮助 → 检查更新」手动检查，或在仓库的 Actions 页面手动运行「中文桌面版 · 同步上游并发布」。

## 汉化是怎么做的

上游源码保持原样，汉化在构建时自动套用，所以合并上游更新不会冲突：

| 文件 | 作用 |
| --- | --- |
| `zh/zh-CN.json` | 英文 → 中文词典。键可以写成 `文件路径::原文`，只在那个文件里使用这个译法 |
| `zh/apply.mjs` | 构建前运行，按词典替换界面文字；被代码当作数据比较的字符串会自动跳过 |
| `zh/deny.json` | 不要翻译的字符串（例如需要和数据库值保持一致的） |
| `zh/zh-data-labels.tsx` | 只在显示时翻译少数来自数据的值（做多/做空、盈利/亏损等） |

上游新增了英文文字时：

```bash
pnpm install
node zh/apply.mjs --extract   # 生成 zh/untranslated.json，列出还没翻译的文字
# 把译文补进 zh/zh-CN.json，推送后会自动重新打包发布
```

## 本地开发

```bash
pnpm install --node-linker=hoisted
node zh/apply.mjs          # 注意：会直接改写 apps/web/src，提交前用 git checkout apps 还原
pnpm build
node desktop/scripts/assemble.mjs
cd desktop && npm install && npm start
```

基于 MIT 许可的 LuxAlgo Trade Journal，非 LuxAlgo 官方产品。按上游商标政策（`TRADEMARKS.md`），衍生版本不使用「Trade Journal」名称和 LuxAlgo 标志，所以桌面版改名为「复盘本」并换了标志。不构成投资建议。
