import { app, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";

// Updates for installed builds, from the releases the installer was published
// to (see `publish` in config/electron-builder.yml). New versions download in
// the background; the person chooses when to restart into one.

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "current" | "error" | "unsupported";

export interface UpdateState {
  version: string;
  status: UpdateStatus;
  /** The version waiting to install, once one is found. */
  next: string | null;
  /** Download progress, 0 to 100. */
  percent: number;
  error: string | null;
}

const EVERY = 6 * 60 * 60 * 1000;

export function setupUpdates(window: () => BrowserWindow | null): { state: () => UpdateState; check: () => Promise<UpdateState>; install: () => void } {
  const { autoUpdater } = electronUpdater;
  const state: UpdateState = { version: app.getVersion(), status: app.isPackaged ? "idle" : "unsupported", next: null, percent: 0, error: null };
  const tell = () => window()?.webContents.send("cadence:event", { type: "update", state: { ...state } });
  const set = (patch: Partial<UpdateState>) => {
    Object.assign(state, patch);
    tell();
  };
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
    autoUpdater.on("update-available", (info) => set({ status: "available", next: info.version }));
    autoUpdater.on("update-not-available", () => set({ status: "current" }));
    autoUpdater.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => set({ status: "ready", next: info.version, percent: 100 }));
    autoUpdater.on("error", (err) => set({ status: "error", error: err.message }));
    const run = () => void autoUpdater.checkForUpdates().catch((err: Error) => set({ status: "error", error: err.message }));
    setTimeout(run, 10_000).unref();
    setInterval(run, EVERY).unref();
  }
  return {
    state: () => ({ ...state }),
    check: async () => {
      if (!app.isPackaged) return { ...state };
      await autoUpdater.checkForUpdates().catch((err: Error) => set({ status: "error", error: err.message }));
      return { ...state };
    },
    install: () => {
      if (state.status === "ready") autoUpdater.quitAndInstall();
    },
  };
}
