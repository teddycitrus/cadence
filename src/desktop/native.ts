import { app, dialog, ipcMain, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions, type Rectangle } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { setupUpdates } from "./updates";

// What the desktop app adds around Cadence's pages: the bridge's handlers
// (folder picker, reveal in the file manager, memory, updates), the menu, and
// the window's remembered size and position.

const settingsFile = () => join(app.getPath("userData"), "desktop.json");

export interface DesktopSettings {
  port?: number;
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

export function registerNative(opts: { window: () => BrowserWindow | null; serverMemoryMb: () => Promise<number | null>; updates: ReturnType<typeof setupUpdates> }): void {
  ipcMain.handle("cadence:pick-folder", async (e, title?: string) => {
    const win = opts.window();
    const options = { title: title ?? "Choose a folder", properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
    const result = win && e.sender === win.webContents ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("cadence:reveal-path", async (_e, path: string) => {
    // Only real, absolute paths; a page cannot use this to launch anything else.
    if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path)) return false;
    const error = await shell.openPath(path);
    return error === "";
  });
  ipcMain.handle("cadence:memory", async () => {
    const processes: { type: string; mb: number }[] = app.getAppMetrics().map((m) => ({ type: m.type, mb: Math.round((m.memory.workingSetSize ?? 0) / 1024) }));
    const server = await opts.serverMemoryMb();
    if (server !== null) processes.push({ type: "Server", mb: server });
    return { processes, totalMb: processes.reduce((t, p) => t + p.mb, 0) };
  });
  ipcMain.handle("cadence:update-state", () => opts.updates.state());
  ipcMain.handle("cadence:check-updates", () => opts.updates.check());
  ipcMain.handle("cadence:install-update", () => opts.updates.install());

  const mac = process.platform === "darwin";
  const settings: MenuItemConstructorOptions = { label: "Settings...", accelerator: "CmdOrCtrl+,", click: () => command(opts.window(), "settings") };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ label: app.name, submenu: [{ role: "about" as const }, { type: "separator" as const }, settings, { label: "Check for Updates...", click: () => command(opts.window(), "updates") }, { type: "separator" as const }, { role: "services" as const }, { type: "separator" as const }, { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const }] }] : []),
    { label: "File", submenu: [...(mac ? [] : [settings, { type: "separator" as const }]), { label: "Open Data Folder", click: () => void shell.openPath(app.getPath("userData")) }, { type: "separator" as const }, mac ? { role: "close" as const } : { role: "quit" as const }] },
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
