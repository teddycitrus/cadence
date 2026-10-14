import { app, dialog, ipcMain, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions, type Rectangle } from "electron";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { onOrigin } from "./connection";
import { isAbsolute, join } from "node:path";
import type { setupUpdates } from "./updates";

// What the desktop app adds around Cadence's pages: the bridge's handlers
// (folder picker, reveal in the file manager, memory, updates), the menu, and
// the window's remembered size and position.

const settingsFile = () => join(app.getPath("userData"), "desktop.json");

export interface DesktopSettings {
  port?: number;
  /** The team server this app joined (its origin), or null to run Cadence on this computer. */
  server?: string | null;
  bounds?: Rectangle;
  maximized?: boolean;
}

export function readSettings(): DesktopSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as DesktopSettings;
  } catch {
    return {};
  }
}

export function writeSettings(patch: DesktopSettings): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }));
  } catch {
    // not fatal: the defaults apply next time
  }
}

/** Remembers the window's size, position, and maximized state. */
export function rememberBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (win.isDestroyed()) return;
      writeSettings({ maximized: win.isMaximized(), ...(win.isMaximized() || win.isMinimized() ? {} : { bounds: win.getBounds() }) });
    }, 400);
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    if (!win.isDestroyed()) writeSettings({ maximized: win.isMaximized(), ...(win.isMaximized() || win.isMinimized() ? {} : { bounds: win.getBounds() }) });
  });
}

/** Sends a command to the page (opened settings, keyboard shortcuts, ...). */
const command = (win: BrowserWindow | null, action: string) => win?.webContents.send("cadence:event", { type: "menu", action });

export interface NativeOptions {
  window: () => BrowserWindow | null;
  serverMemoryMb: () => Promise<number | null>;
  updates: ReturnType<typeof setupUpdates>;
  /** The Cadence origin the window shows; only its pages may use the bridge. */
  origin: () => string;
  connection: () => { mode: "local" | "team"; url: string | null };
  joinServer: (address: string) => Promise<void>;
  useThisComputer: () => Promise<void>;
}

export function registerNative(opts: NativeOptions): void {
  // The bridge answers Cadence's own pages only, and the parts that touch this computer's files
  // only while the window shows this computer's Cadence (a team server has no use for local paths).
  const fromCadence = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => onOrigin(e.senderFrame?.url ?? "", opts.origin());
  const local = (e: Electron.IpcMainInvokeEvent) => fromCadence(e) && opts.connection().mode === "local";
  ipcMain.on("cadence:connection", (e) => {
    e.returnValue = fromCadence(e) ? opts.connection() : { mode: "local", url: null };
  });
  ipcMain.handle("cadence:join-server", async (e, address: string) => {
    if (!fromCadence(e) || typeof address !== "string") return { ok: false, error: "Not allowed" };
    try {
      await opts.joinServer(address);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("cadence:use-this-computer", async (e) => {
    if (fromCadence(e)) await opts.useThisComputer();
  });
  ipcMain.handle("cadence:pick-folder", async (e, title?: string) => {
    if (!local(e)) return null;
    const win = opts.window();
    const options = { title: title ?? "Choose a folder", properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
    const result = win && e.sender === win.webContents ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("cadence:reveal-path", async (e, path: string) => {
    if (!local(e) || typeof path !== "string" || !isAbsolute(path) || !existsSync(path)) return false;
    // A folder opens in the file manager; a file is only shown in its folder, never run.
    if (!statSync(path).isDirectory()) {
      shell.showItemInFolder(path);
      return true;
    }
    return (await shell.openPath(path)) === "";
  });
  ipcMain.handle("cadence:memory", async (e) => {
    if (!fromCadence(e)) return { processes: [], totalMb: 0 };
    const processes: { type: string; mb: number }[] = app.getAppMetrics().map((m) => ({ type: m.type, mb: Math.round((m.memory.workingSetSize ?? 0) / 1024) }));
    const server = await opts.serverMemoryMb();
    if (server !== null) processes.push({ type: "Server", mb: server });
    return { processes, totalMb: processes.reduce((t, p) => t + p.mb, 0) };
  });
  ipcMain.handle("cadence:update-state", (e) => (fromCadence(e) ? opts.updates.state() : null));
  ipcMain.handle("cadence:check-updates", (e) => (fromCadence(e) ? opts.updates.check() : null));
  ipcMain.handle("cadence:install-update", (e) => (fromCadence(e) ? opts.updates.install() : undefined));

  const mac = process.platform === "darwin";
  const settings: MenuItemConstructorOptions = { label: "Settings...", accelerator: "CmdOrCtrl+,", click: () => command(opts.window(), "settings") };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ label: app.name, submenu: [{ role: "about" as const }, { type: "separator" as const }, settings, { label: "Check for Updates...", click: () => command(opts.window(), "updates") }, { type: "separator" as const }, { role: "services" as const }, { type: "separator" as const }, { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const }] }] : []),
    { label: "File", submenu: [...(mac ? [] : [settings, { type: "separator" as const }]), { label: "Join a Team Server...", click: () => command(opts.window(), "settings") }, { type: "separator" as const }, { label: "Open Data Folder", click: () => void shell.openPath(app.getPath("userData")) }, { type: "separator" as const }, mac ? { role: "close" as const } : { role: "quit" as const }] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: () => command(opts.window(), "shortcuts") },
        { label: "Report a Problem...", click: () => command(opts.window(), "report") },
        ...(mac ? [] : [{ type: "separator" as const }, { label: "Check for Updates...", click: () => command(opts.window(), "updates") }]),
        { type: "separator" },
        { label: "Open Logs Folder", click: () => void shell.openPath(join(app.getPath("userData"), "logs")) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
