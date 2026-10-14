import { app, BrowserWindow, desktopCapturer, dialog, screen, session, shell } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { readSettings, registerNative, rememberBounds, writeSettings } from "./native";
import { setupUpdates } from "./updates";

// The desktop shell: one window around the Cadence server, which runs as a
// child process on Electron's own Node (so heavy server work never stalls the
// window). The server keeps the same port between launches when it can,
// because MCP connections, machine links, and share links point at it.

const DEFAULT_PORT = 4317;
const userData = app.getPath("userData");
const dataDir = join(userData, "data");
const logFile = join(userData, "logs", "server.log");

let server: ChildProcess | null = null;
let window: BrowserWindow | null = null;
let origin = "";
let quitting = false;

// A second copy only brings the first one forward (Electron sends it "second-instance") and
// exits at once; it must not go on to open a window and wait for a server it does not own.
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
app.on("second-instance", () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});
app.setAppUserModelId("dev.cadence.app");

/** The saved port if it is free, otherwise any free one (remembered for next time). */
function pickPort(): Promise<number> {
  const saved = readSettings().port;
  const preferred = Number.isInteger(saved) && saved! > 0 && saved! < 65536 ? saved! : DEFAULT_PORT;
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(null));
      probe.listen(port, "127.0.0.1", () => {
        const got = (probe.address() as { port: number }).port;
        probe.close(() => resolve(got));
      });
    });
  return tryPort(preferred).then(async (port) => {
    const chosen = port ?? (await tryPort(0))!;
    writeSettings({ port: chosen });
    return chosen;
  });
}

function startServer(port: number): Promise<string> {
  mkdirSync(join(userData, "logs"), { recursive: true });
  const log = createWriteStream(logFile, { flags: "a" });
  const child = fork(join(__dirname, "server.mjs"), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CADENCE_PORT: String(port), CADENCE_DATA_DIR: dataDir, CADENCE_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  server = child;
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return new Promise((resolve, reject) => {
    const first = (m: { type?: string; url?: string; error?: string }) => {
      if (m.type !== "ready" && m.type !== "failed") return;
      child.off("message", first);
      if (m.type === "ready" && m.url) resolve(m.url);
      else reject(new Error(m.error ?? "The server did not start"));
    };
    child.on("message", first);
    child.once("exit", (code) => {
      reject(new Error(`The server stopped (exit code ${code}). See ${logFile}.`));
      if (!quitting) void serverDied(code);
    });
  });
}

/** The server's own memory in MB, asked over IPC. */
function serverMemoryMb(): Promise<number | null> {
  const child = server;
  if (!child?.connected) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => (child.off("message", on), resolve(null)), 2000);
    const on = (m: { type?: string; rss?: number }) => {
      if (m.type !== "memory") return;
      clearTimeout(timer);
      child.off("message", on);
      resolve(Math.round((m.rss ?? 0) / 1024 / 1024));
    };
    child.on("message", on);
    child.send({ type: "memory" });
  });
}

async function serverDied(code: number | null): Promise<void> {
  server = null;
  const { response } = await dialog.showMessageBox({
    type: "error",
    message: "Cadence's server stopped",
    detail: `It exited with code ${code}. The log is in ${logFile}.`,
    buttons: ["Restart", "Quit"],
  });
  if (response === 1) return app.quit();
  try {
    origin = await startServer(await pickPort());
    await window?.loadURL(origin);
  } catch (err) {
    dialog.showErrorBox("Cadence could not restart", String(err instanceof Error ? err.message : err));
    app.quit();
  }
}

// The startup screen: the logo's loading animation (as in src/web/src/components/Logo.tsx and styles.css).
const LOADING = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><title>Cadence</title><style>
  html, body { margin: 0; height: 100%; background: #e6d1af; }
  body { display: grid; place-items: center; }
  .arc { stroke-dasharray: 100; animation: draw 1.6s cubic-bezier(0.65, 0, 0.35, 1) infinite; }
  .dot { transform-box: fill-box; transform-origin: center; animation: beat 0.8s ease-in-out infinite; }
  @keyframes draw { 0% { stroke-dashoffset: 100; } 45%, 60% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -100; } }
  @keyframes beat { 0%, 100% { transform: scale(1); } 18% { transform: scale(1.4); } 40% { transform: scale(0.95); } }
  @media (prefers-reduced-motion: reduce) { .arc { animation: none; } .dot { animation: none; } }
</style></head><body>
  <svg viewBox="0 0 64 64" width="88" height="88" aria-label="Starting Cadence">
    <path class="arc" d="M40.02 19.98 A17 17 0 1 0 40.02 44.02" pathLength="100" fill="none" stroke="#4b2434" stroke-width="7" stroke-linecap="round"/>
    <circle class="dot" cx="47" cy="32" r="4.5" fill="#586422"/>
  </svg>
</body></html>`)}`;

const webPreferences = { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true };

/** The saved bounds when they are still on a connected display. */
function savedBounds(): Electron.Rectangle | undefined {
  const b = readSettings().bounds;
  if (!b) return undefined;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width && b.x + b.width > area.x && b.y < area.y + area.height && b.y + b.height > area.y;
  return visible ? b : undefined;
}

function createWindow(): BrowserWindow {
  const bounds = savedBounds();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    title: "Cadence",
    icon: join(__dirname, "icon.png"),
    backgroundColor: "#e6d1af",
    autoHideMenuBar: true,
    show: false,
    webPreferences,
  });
  if (readSettings().maximized) win.maximize();
  rememberBounds(win);
  win.once("ready-to-show", () => win.show());
  // Cadence's own pages (popped-out canvases and chats) open in app windows; everything else goes to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (origin && url.startsWith(origin)) return { action: "allow", overrideBrowserWindowOptions: { icon: join(__dirname, "icon.png"), backgroundColor: "#e6d1af", autoHideMenuBar: true, width: 1200, height: 800, webPreferences } };
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(origin) || url.startsWith("data:")) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  win.on("closed", () => (window = null));
  return win;
}

app.whenReady().then(async () => {
  if (!primary) return;
  const updates = setupUpdates(() => window);
  registerNative({ window: () => window, serverMemoryMb, updates });
  // Bug reports record the screen; the system picker lets the person choose what.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_req, callback) => {
      void desktopCapturer.getSources({ types: ["screen", "window"] }).then((sources) => callback(sources[0] ? { video: sources[0] } : {}), () => callback({}));
    },
    { useSystemPicker: true },
  );
  window = createWindow();
  await window.loadURL(LOADING);
  try {
    origin = await startServer(await pickPort());
    await window.loadURL(origin);
  } catch (err) {
    dialog.showErrorBox("Cadence could not start", String(err instanceof Error ? err.message : err));
    app.quit();
  }
});

app.on("activate", () => {
  if (!window && origin) {
    window = createWindow();
    void window.loadURL(origin);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Ask the server to shut down cleanly (it stops terminals, dev servers, and browsers), then quit.
app.on("before-quit", (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  // Whatever happens to the server, the app is gone a few seconds after quitting.
  setTimeout(() => app.exit(0), 8000);
  const child = server;
  const done = () => app.quit();
  child.once("exit", done);
  child.send("shutdown");
  setTimeout(() => {
    child.kill();
    done();
  }, 5000).unref();
});
