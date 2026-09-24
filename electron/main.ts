/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Electron main process for SendFiles.
 *
 * SendFiles is a local server other devices connect to, so the desktop app is
 * a window onto that server rather than a self-contained UI: the Express
 * signalling server runs as a child process and keeps serving the LAN while
 * the window is open. Phones on the same Wi-Fi still reach it at the network
 * URL shown in the app.
 *
 * The server is spawned with Electron's own binary in Node mode
 * (ELECTRON_RUN_AS_NODE), so no separate Node runtime has to be shipped.
 */

import { app, BrowserWindow, shell, ipcMain, dialog, session, clipboard, Menu } from "electron";
import { spawn, ChildProcess } from "child_process";
import electronUpdater from "electron-updater";
import path from "path";
import fs from "fs";
import os from "os";

const { autoUpdater } = electronUpdater;

interface ServerInfo {
  httpPort: number;
  httpsPort: number;
  httpUrl: string;
  httpsUrl: string;
}

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverInfo: ServerInfo | null = null;
let isQuitting = false;

const isDev = !app.isPackaged;

/**
 * Resolves the bundled server entry point.
 *
 * Packaged, it is unpacked to resources/server by electron-builder. In dev the
 * compiled shell lives in dist-electron/, so the server sits one level up in
 * dist/. Candidates are probed rather than assumed, because app.getAppPath()
 * points at different places depending on how Electron was invoked.
 */
function resolveServerEntry(): string {
  const candidates = isDev
    ? [
        path.join(__dirname, "..", "dist", "server.cjs"),
        path.join(app.getAppPath(), "dist", "server.cjs"),
        path.join(process.cwd(), "dist", "server.cjs")
      ]
    : [
        path.join(process.resourcesPath, "server", "server.cjs"),
        path.join(app.getAppPath(), "dist", "server.cjs")
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Could not locate server.cjs. Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}`
  );
}

/**
 * Starts the Express server and resolves once it reports the port it bound.
 *
 * The server picks its own port if the preferred one is taken, so we wait for
 * its SENDFILES_READY line rather than assuming.
 */
function startServer(): Promise<ServerInfo> {
  return new Promise((resolve, reject) => {
    const serverEntry = resolveServerEntry();

    serverProcess = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        // The Electron window is the UI; never spawn a browser as well.
        NO_OPEN: "true"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let stderrBuffer = "";

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`The server did not start within 30 seconds.\n\n${stderrBuffer.slice(-800)}`));
    }, 30000);

    serverProcess.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(`[server] ${text}`);

      const marker = text.indexOf("SENDFILES_READY ");
      if (marker !== -1 && !settled) {
        const line = text.slice(marker + "SENDFILES_READY ".length).split("\n")[0].trim();
        try {
          const info = JSON.parse(line) as ServerInfo;
          settled = true;
          clearTimeout(timeout);
          resolve(info);
        } catch (err) {
          // Keep waiting; a later chunk may carry the complete line.
        }
      }
    });

    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer += text;
      process.stderr.write(`[server] ${text}`);
    });

    serverProcess.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      serverProcess = null;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`The server exited with code ${code}.\n\n${stderrBuffer.slice(-800)}`));
      } else if (!isQuitting) {
        // The server died while the app was running: the window is now useless.
        dialog.showErrorBox(
          "SendFiles server stopped",
          `The background server exited unexpectedly (code ${code}). Please restart SendFiles.`
        );
        app.quit();
      }
    });
  });
}

function stopServer(): void {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;
  try {
    proc.kill();
  } catch {
    // Already gone.
  }
}

/**
 * Restricts the renderer to the local server origin.
 *
 * The window loads an http:// origin we control, so anything that would take
 * it elsewhere is either a mistake or hostile; external links open in the
 * user's real browser instead.
 */
function applyNavigationGuards(window: BrowserWindow, allowedOrigin: string): void {
  const isAllowed = (target: string) => {
    try {
      return new URL(target).origin === allowedOrigin;
    } catch {
      return false;
    }
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      if (url.startsWith("https://")) shell.openExternal(url);
    }
  });

  // Nothing in this app needs a webview, camera, microphone or geolocation.
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

/**
 * Content Security Policy for the app window.
 *
 * Applied as a response header here rather than in the served HTML so the
 * browser-based deployment is unaffected. The allowances are exactly what the
 * app uses: Google Fonts for typography, blob/data URLs for assembled file
 * downloads and QR codes, and ws/wss for signalling.
 */
function applyContentSecurityPolicy(origin: string): void {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${origin} ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com`,
    "worker-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp]
      }
    });
  });
}

// ----------------------------------------------------
// Automatic updates
// ----------------------------------------------------

let updateCheckInFlight = false;

/**
 * Wires up background update checks against the GitHub releases feed.
 *
 * Downloads happen in the background and install on quit, so an update never
 * interrupts a transfer in progress. Nothing is installed without the person
 * agreeing to it first.
 *
 * macOS is deliberately skipped: Squirrel.Mac refuses to apply an update to an
 * app that is not code-signed, and these builds are not. Pretending otherwise
 * would just surface a confusing failure, so mac users are pointed at the
 * releases page instead.
 */
function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  if (process.platform === "darwin") return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    // A failed check must never bother the user; it is not their problem.
    console.error("[updater]", err?.message || err);
  });

  autoUpdater.on("update-available", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `SendFiles ${info.version} is available.`,
      detail: `You are running ${app.getVersion()}. The update downloads in the background and installs the next time you quit.`
    });
    if (response === 0) autoUpdater.downloadUpdate().catch(() => {});
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 1,
      cancelId: 1,
      title: "Update ready",
      message: `SendFiles ${info.version} is ready to install.`,
      detail: "Restarting now will interrupt any transfer in progress."
    });
    if (response === 0) {
      isQuitting = true;
      stopServer();
      autoUpdater.quitAndInstall();
    }
  });

  // Check shortly after launch so startup is not delayed, then daily.
  setTimeout(() => checkForUpdates(false), 10000);
  setInterval(() => checkForUpdates(false), 24 * 60 * 60 * 1000);
}

async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (interactive) {
      await dialog.showMessageBox({
        type: "info",
        title: "Updates",
        message: "Update checks are only available in an installed build.",
        detail: "You are running SendFiles from source."
      });
    }
    return;
  }

  if (process.platform === "darwin") {
    if (interactive) {
      const { response } = await dialog.showMessageBox({
        type: "info",
        buttons: ["Open releases page", "Close"],
        defaultId: 0,
        cancelId: 1,
        title: "Updates",
        message: "Automatic updates are not available on macOS.",
        detail: "These builds are not code-signed, which macOS requires before an application may update itself. You can download the latest version manually."
      });
      if (response === 0) {
        shell.openExternal("https://github.com/zihaaaad/SendFiles/releases/latest");
      }
    }
    return;
  }

  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (interactive && !result?.updateInfo) {
      await dialog.showMessageBox({
        type: "info",
        title: "Updates",
        message: "SendFiles is up to date.",
        detail: `Version ${app.getVersion()}.`
      });
    }
  } catch (err: any) {
    if (interactive) {
      await dialog.showMessageBox({
        type: "warning",
        title: "Update check failed",
        message: "Could not check for updates.",
        detail: err?.message || String(err)
      });
    }
  } finally {
    updateCheckInFlight = false;
  }
}

function buildApplicationMenu(info: ServerInfo): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open in Browser",
          accelerator: "CmdOrCtrl+B",
          click: () => shell.openExternal(info.httpUrl)
        },
        {
          label: "Copy LAN Address",
          accelerator: "CmdOrCtrl+Shift+C",
          click: () => {
            const lanUrl = firstLanUrl(info.httpPort) || info.httpUrl;
            clipboard.writeText(lanUrl);
          }
        },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(isDev ? [{ role: "toggleDevTools" } as Electron.MenuItemConstructorOptions] : [])
      ]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => checkForUpdates(true)
        },
        { type: "separator" },
        {
          label: "Project Repository",
          click: () => shell.openExternal("https://github.com/zihaaaad/SendFiles")
        },
        {
          label: "About SendFiles",
          click: () => {
            dialog.showMessageBox({
              type: "info",
              title: "About SendFiles",
              message: "SendFiles",
              detail:
                `Version ${app.getVersion()}\n\n` +
                `Serving on ${info.httpUrl}\n` +
                `LAN address: ${firstLanUrl(info.httpPort) || "unavailable"}\n\n` +
                `Other devices on this network can open the LAN address to send and receive files.`
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** First non-internal IPv4 address, for the shareable LAN URL. */
function firstLanUrl(port: number): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const alias of interfaces[name] || []) {
      if (alias.family === "IPv4" && !alias.internal) {
        return `http://${alias.address}:${port}`;
      }
    }
  }
  return null;
}

function createWindow(info: ServerInfo): BrowserWindow {
  const origin = new URL(info.httpUrl).origin;

  const window = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    show: false,
    backgroundColor: "#f4f7f5",
    title: "SendFiles",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  });

  applyNavigationGuards(window, origin);

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });

  window.loadURL(info.httpUrl);
  return window;
}

// A second launch should focus the existing window rather than starting a
// second server that fights over ports.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      serverInfo = await startServer();
    } catch (err: any) {
      dialog.showErrorBox(
        "SendFiles could not start",
        `The background server failed to start.\n\n${err?.message || String(err)}`
      );
      app.quit();
      return;
    }

    applyContentSecurityPolicy(new URL(serverInfo.httpUrl).origin);
    buildApplicationMenu(serverInfo);
    mainWindow = createWindow(serverInfo);
    initAutoUpdater();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverInfo) {
        mainWindow = createWindow(serverInfo);
      }
    });
  });

  // Renderer-facing API. Deliberately read-only: the renderer cannot ask the
  // main process to touch the filesystem or run anything.
  ipcMain.handle("app:get-server-info", () => serverInfo);
  ipcMain.handle("app:get-lan-url", () => (serverInfo ? firstLanUrl(serverInfo.httpPort) : null));
  ipcMain.handle("app:get-version", () => app.getVersion());

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopServer();
  });

  app.on("quit", stopServer);
  process.on("exit", stopServer);
}
