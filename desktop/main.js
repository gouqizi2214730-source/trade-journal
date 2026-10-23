// 复盘本 Windows 桌面版（Electron 外壳）
//
// 启动随安装包附带的 Node.js 运行 Next.js 独立服务（只监听 127.0.0.1 的随机端口），
// 数据保存在 %APPDATA%\FupanBook\data，再用窗口打开它。
// 自动更新：electron-updater 从 GitHub Releases（gouqizi2214730-source/trade-journal）检查新版本。
const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, dialog, shell, ipcMain } = require("electron");
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
let tray = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });
}

const userDir = () => app.getPath("userData");
const dataDir = () => path.join(userDir(), "data");
const logDir = () => path.join(userDir(), "logs");

// ---------------------------------------------------------------- 桌面设置
const SETTINGS_DEFAULTS = {
  syncIntervalMin: 20, // 0 = 关闭定时同步
  closeToTray: true,
  trayHintShown: false,
  backupEnabled: true,
  backupDir: null, // null = 文档\复盘本备份
  backupKeep: 30,
  lastBackupAt: null,
};
const settingsFile = () => path.join(userDir(), "desktop-settings.json");
let settings = null;
const loadSettings = () => {
  try {
    settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    settings = { ...SETTINGS_DEFAULTS };
  }
  return settings;
};
const saveSettings = (patch) => {
  settings = { ...(settings ?? loadSettings()), ...patch };
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    log("save settings failed", e && e.message);
  }
};
const backupDir = () => settings.backupDir || path.join(app.getPath("documents"), "复盘本备份");

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

/** 调用本地复盘本服务的 JSON 接口 */
const api = (method, apiPath, body, timeoutMs = 10 * 60 * 1000) =>
  new Promise((resolve, reject) => {
    if (!serverUrl) return reject(new Error("服务尚未启动"));
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      serverUrl + apiPath,
      {
        method,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            /* non-JSON */
          }
          if (res.statusCode >= 400) reject(new Error((data && data.error) || `HTTP ${res.statusCode}`));
          else resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("请求超时")));
    if (payload) req.write(payload);
    req.end();
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
  // 关闭窗口时缩到托盘，后台继续定时同步和备份
  mainWindow.on("close", (event) => {
    if (quitting || !settings.closeToTray || !tray) return;
    event.preventDefault();
    mainWindow.hide();
    if (!settings.trayHintShown) {
      saveSettings({ trayHintShown: true });
      notify("复盘本仍在后台运行", "会继续定时同步和备份。右键托盘图标可以退出，或在「文件」菜单里关闭此行为。");
    }
  });

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
    const firstStart = !serverUrl;
    const url = serverUrl ?? (await startServer());
    await mainWindow.loadURL(url);
    if (firstStart) startBackgroundJobs();
  } catch (e) {
    log("startup failed", e && e.stack);
    if (quitting) return;
    dialog.showErrorBox(APP_NAME, `启动失败：${e.message}\n日志位置：${logDir()}`);
    app.quit();
  }
};


// ---------------------------------------------------------------- 窗口、通知、托盘
const showWindow = () => {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};
const notify = (title, body) => {
  try {
    if (Notification.isSupported()) new Notification({ title, body, icon: appIcon() }).show();
  } catch (e) {
    log("notify failed", e && e.message);
  }
};
const appIcon = () => nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
const setupTray = () => {
  try {
    const image = appIcon().resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip(APP_NAME);
    tray.on("click", showWindow);
    refreshTrayMenu();
  } catch (e) {
    log("tray failed", e && e.message);
    tray = null;
  }
};
const refreshTrayMenu = () => {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开复盘本", click: showWindow },
      { type: "separator" },
      { label: syncing ? "正在同步…" : "立即同步全部账户", enabled: !syncing, click: () => syncAll({ manual: true }) },
      { label: "立即备份", click: () => runBackup({ manual: true }) },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
};

// ---------------------------------------------------------------- 定时同步
let syncing = false;
let syncTimer = null;
let lastSyncErrorNotified = 0;
const syncAll = async ({ manual = false } = {}) => {
  if (syncing || !serverUrl) return;
  syncing = true;
  refreshTrayMenu();
  let inserted = 0;
  const failures = [];
  try {
    const { accounts = [] } = (await api("GET", "/api/accounts")) ?? {};
    const targets = accounts.filter((a) => a.kind === "sync" && a.connected && !a.archivedAt && (manual || a.autoSync));
    for (const account of targets) {
      try {
        const result = await api("POST", `/api/accounts/${encodeURIComponent(account.id)}/actions`, { action: "sync" });
        const n = (result && result.sync && result.sync.inserted) || 0;
        inserted += n;
        log("sync", account.name, "inserted", n);
      } catch (e) {
        failures.push(`${account.name}：${e.message}`);
        log("sync failed", account.name, e && e.message);
      }
    }
    if (inserted > 0) {
      notify("同步完成", `新增 ${inserted} 笔成交。刷新页面即可看到最新数据。`);
      if (mainWindow && !mainWindow.isVisible()) mainWindow.webContents.reload();
    } else if (manual && !failures.length) {
      notify("同步完成", targets.length ? "没有新的成交。" : "没有可同步的券商账户。");
    }
    // 失败提醒：手动同步每次都提示，定时同步每 6 小时最多提示一次，避免刷屏
    if (failures.length && (manual || Date.now() - lastSyncErrorNotified > 6 * 3600e3)) {
      lastSyncErrorNotified = Date.now();
      notify("部分账户同步失败", failures.join("\n").slice(0, 250));
    }
  } catch (e) {
    log("sync all failed", e && e.message);
    if (manual) notify("同步失败", e.message);
  } finally {
    syncing = false;
    refreshTrayMenu();
  }
};
const scheduleSync = () => {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  const minutes = Number(settings.syncIntervalMin) || 0;
  if (minutes > 0) syncTimer = setInterval(() => syncAll(), minutes * 60 * 1000);
};

// ---------------------------------------------------------------- 每日备份
// 用 better-sqlite3 的在线备份接口（程序运行中也能得到一致的副本），由随包附带的 Node 执行。
const BACKUP_SCRIPT = `
const path = require("node:path");
const [, , webDir, src, dest] = process.argv;
const Database = require(require.resolve("better-sqlite3", { paths: [webDir] }));
const db = new Database(src, { readonly: true, fileMustExist: true });
db.backup(dest).then(() => { db.close(); process.exit(0); }).catch((e) => { console.error(e && e.message); process.exit(1); });
`;
let backingUp = false;
const runBackup = async ({ manual = false } = {}) => {
  if (backingUp) return;
  const src = path.join(dataDir(), "journal.db");
  if (!fs.existsSync(src)) return;
  backingUp = true;
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const name = `复盘本备份-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.db`;
    const dest = path.join(dir, name);
    const script = path.join(userDir(), "backup-runner.cjs");
    fs.writeFileSync(script, BACKUP_SCRIPT);
    const { node, cwd } = serverPaths();
    const webDir = path.join(cwd, "apps", "web");
    await new Promise((resolve, reject) => {
      execFile(node, [script, webDir, src, dest], { windowsHide: true, timeout: 5 * 60 * 1000 }, (err, _out, stderr) =>
        err ? reject(new Error(String(stderr || err.message).trim())) : resolve(),
      );
    });
    saveSettings({ lastBackupAt: new Date().toISOString() });
    log("backup ok", dest);
    // 只清理本程序生成的备份文件，保留最近 N 份
    const ours = fs
      .readdirSync(dir)
      .filter((f) => /^复盘本备份-\d{8}-\d{4}\.db$/.test(f))
      .sort()
      .reverse();
    for (const old of ours.slice(Math.max(1, Number(settings.backupKeep) || 30))) {
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch (e) {
        log("prune backup failed", old, e && e.message);
      }
    }
    if (manual) notify("备份完成", `已保存到 ${dest}`);
  } catch (e) {
    log("backup failed", e && e.message);
    notify("备份失败", `${e.message}\n日志：${logDir()}`);
  } finally {
    backingUp = false;
  }
};
const backupIfDue = () => {
  if (!settings.backupEnabled) return;
  const last = settings.lastBackupAt ? Date.parse(settings.lastBackupAt) : 0;
  if (!last || Date.now() - last > 20 * 3600e3) runBackup();
};
const chooseBackupDir = async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择备份文件夹",
    defaultPath: backupDir(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (!result.canceled && result.filePaths[0]) {
    saveSettings({ backupDir: result.filePaths[0] });
    buildMenu();
    runBackup({ manual: true });
  }
};

// 服务就绪后启动的后台任务
const startBackgroundJobs = () => {
  setTimeout(() => syncAll(), 30 * 1000);
  scheduleSync();
  setTimeout(backupIfDue, 60 * 1000);
  setInterval(backupIfDue, 60 * 60 * 1000);
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
          { label: "立即同步全部账户", accelerator: "F5", click: () => syncAll({ manual: true }) },
          {
            label: "定时同步",
            submenu: [0, 10, 20, 30, 60].map((m) => ({
              label: m ? `每 ${m} 分钟` : "关闭",
              type: "radio",
              checked: Number(settings.syncIntervalMin) === m,
              click: () => {
                saveSettings({ syncIntervalMin: m });
                scheduleSync();
              },
            })),
          },
          { type: "separator" },
          { label: "立即备份", click: () => runBackup({ manual: true }) },
          { label: "打开备份文件夹", click: () => (fs.mkdirSync(backupDir(), { recursive: true }), shell.openPath(backupDir())) },
          { label: "更改备份文件夹…", click: chooseBackupDir },
          {
            label: "每日自动备份",
            type: "checkbox",
            checked: !!settings.backupEnabled,
            click: (item) => saveSettings({ backupEnabled: item.checked }),
          },
          { type: "separator" },
          { label: "打开数据文件夹", click: () => shell.openPath(dataDir()) },
          { label: "打开日志文件夹", click: () => shell.openPath(logDir()) },
          {
            label: "关闭窗口时最小化到托盘",
            type: "checkbox",
            checked: !!settings.closeToTray,
            click: (item) => saveSettings({ closeToTray: item.checked }),
          },
          { type: "separator" },
          { label: "退出", click: () => app.quit() },
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
  if (process.platform === "win32") app.setAppUserModelId("io.github.gouqizi2214730.fupanbook");
  loadSettings();
  buildMenu();
  setupTray();
  createWindow();
  setupUpdater();
});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});
// 有托盘时窗口隐藏不退出；没有托盘（创建失败或关闭了该选项）则照常退出
app.on("window-all-closed", () => {
  if (!tray || !settings.closeToTray || quitting) app.quit();
});
process.on("exit", stopServer);
ipcMain.handle("app:version", () => app.getVersion());
