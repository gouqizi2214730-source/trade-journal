// 复盘本 Windows 桌面版（Electron 外壳）
//
// 启动随安装包附带的 Node.js 运行 Next.js 独立服务（只监听 127.0.0.1 的随机端口），
// 数据保存在 %APPDATA%\FupanBook\data，再用窗口打开它。
// 自动更新：electron-updater 从 GitHub Releases（gouqizi2214730-source/trade-journal）检查新版本。
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

const APP_NAME = "复盘本";
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let mainWindow = null;
let server = null;
let serverUrl = null;
let quitting = false;
let manualUpdateCheck = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

const userDir = () => app.getPath("userData");
const dataDir = () => path.join(userDir(), "data");
const logDir = () => path.join(userDir(), "logs");

const log = (...args) => {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(path.join(logDir(), "app.log"), `[${new Date().toISOString()}] ${args.join(" ")}\n`);
  } catch {
    /* logging must never break the app */
  }
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const waitForServer = (url, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(3000, () => req.destroy());
    };
    const retry = () => {
      if (quitting) return reject(new Error("quitting"));
      if (Date.now() - started > timeoutMs) return reject(new Error("服务启动超时"));
      setTimeout(attempt, 300);
    };
    attempt();
  });

const serverPaths = () => {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    return {
      node: path.join(res, "node", process.platform === "win32" ? "node.exe" : "node"),
      cwd: path.join(res, "app"),
      script: path.join(res, "app", "apps", "web", "server.js"),
    };
  }
  // 开发模式：用本机 node 运行仓库里构建好的 standalone 输出
  const standalone = path.join(__dirname, "..", "apps", "web", ".next", "standalone");
  return { node: process.env.NODE_BINARY || "node", cwd: standalone, script: path.join(standalone, "apps", "web", "server.js") };
};

const startServer = async () => {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });
  const port = await freePort();
  const { node, cwd, script } = serverPaths();
  const out = fs.openSync(path.join(logDir(), "server.log"), "a");
  log("starting server", node, script, "port", port);
  server = spawn(node, [script], {
    cwd,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      JOURNAL_DATA_DIR: dataDir(),
    },
  });
  server.on("exit", (code, signal) => {
    log("server exited", code, signal);
    server = null;
    if (!quitting) {
      dialog.showErrorBox(
        APP_NAME,
        `后台服务意外退出（代码 ${code ?? signal}）。\n日志位置：${path.join(logDir(), "server.log")}\n请重新打开程序。`,
      );
      app.quit();
    }
  });
  serverUrl = `http://127.0.0.1:${port}`;
  await waitForServer(serverUrl + "/login");
  return serverUrl;
};

const stopServer = () => {
  if (!server) return;
  const pid = server.pid;
  try {
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else server.kill("SIGTERM");
  } catch (e) {
    log("stop failed", e);
  }
  server = null;
};

const loadingPage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>html,body{height:100%;margin:0;background:#0a0a0a;color:#e5e5e5;font:15px "Microsoft YaHei UI","PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center}
.s{width:28px;height:28px;border:3px solid #333;border-top-color:#3b82f6;border-radius:50%;animation:r 0.8s linear infinite;margin:0 auto 14px}@keyframes r{to{transform:rotate(360deg)}}</style></head>
<body><div><div class="s"></div>正在启动复盘本…</div></body></html>`)}`;

const isLocal = (url) => serverUrl && url.startsWith(serverUrl);

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => (mainWindow = null));

  // 外部链接用系统浏览器打开，窗口只显示本地服务
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) shell.openExternal(url);
    return { action: isLocal(url) ? "allow" : "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isLocal(url) && !url.startsWith("data:")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  // 语音听写需要麦克风权限；其余权限一律拒绝
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === "media" || permission === "clipboard-sanitized-write"),
  );

  await mainWindow.loadURL(loadingPage);
  try {
    const url = await startServer();
    await mainWindow.loadURL(url);
  } catch (e) {
    log("startup failed", e && e.stack);
    if (quitting) return;
    dialog.showErrorBox(APP_NAME, `启动失败：${e.message}\n日志位置：${logDir()}`);
    app.quit();
  }
};

// ---------------------------------------------------------------- 自动更新
const setupUpdater = () => {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => log("[update]", m), warn: (m) => log("[update]", m), error: (m) => log("[update]", m), debug: () => {} };

  autoUpdater.on("update-available", (info) => {
    log("update available", info.version);
    if (manualUpdateCheck)
      dialog.showMessageBox(mainWindow, { type: "info", title: "发现新版本", message: `发现新版本 ${info.version}，正在后台下载…` });
  });
  autoUpdater.on("update-not-available", () => {
    if (manualUpdateCheck)
      dialog.showMessageBox(mainWindow, { type: "info", title: "检查更新", message: `已是最新版本（${app.getVersion()}）。` });
    manualUpdateCheck = false;
  });
  autoUpdater.on("error", (err) => {
    log("update error", err && err.message);
    if (manualUpdateCheck) dialog.showMessageBox(mainWindow, { type: "warning", title: "检查更新失败", message: String(err && err.message) });
    manualUpdateCheck = false;
  });
  autoUpdater.on("update-downloaded", async (info) => {
    manualUpdateCheck = false;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["立即重启并安装", "稍后（退出时自动安装）"],
      defaultId: 0,
      cancelId: 1,
      title: "更新已就绪",
      message: `新版本 ${info.version} 已下载完成。`,
      detail: "你的日志数据保存在独立的数据文件夹中，更新不会影响数据。",
    });
    if (response === 0) {
      quitting = true;
      stopServer();
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
  });

  const check = () => autoUpdater.checkForUpdates().catch((e) => log("update check failed", e && e.message));
  setTimeout(check, 10000);
  setInterval(check, UPDATE_INTERVAL_MS);
};

const checkUpdatesNow = () => {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, { type: "info", message: "开发模式下不检查更新。" });
    return;
  }
  manualUpdateCheck = true;
  autoUpdater.checkForUpdates().catch((e) => log("manual update check failed", e && e.message));
};

const buildMenu = () =>
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          { label: "打开数据文件夹", click: () => shell.openPath(dataDir()) },
          { label: "打开日志文件夹", click: () => shell.openPath(logDir()) },
          { type: "separator" },
          { label: "退出", role: "quit" },
        ],
      },
      { label: "编辑", submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" }] },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "刷新" },
          { role: "toggleDevTools", label: "开发者工具" },
          { type: "separator" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" },
        ],
      },
      {
        label: "帮助",
        submenu: [
          { label: "检查更新…", click: checkUpdatesNow },
          { label: "项目主页", click: () => shell.openExternal("https://github.com/gouqizi2214730-source/trade-journal") },
          { type: "separator" },
          {
            label: "关于",
            click: () =>
              dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "关于",
                message: `${APP_NAME} ${app.getVersion()}`,
                detail: "基于 LuxAlgo 开源项目 Trade Journal（MIT 许可）的中文桌面版，非 LuxAlgo 官方产品。\n不构成投资建议。",
              }),
          },
        ],
      },
    ]),
  );

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  setupUpdater();
});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});
app.on("window-all-closed", () => app.quit());
process.on("exit", stopServer);
ipcMain.handle("app:version", () => app.getVersion());
