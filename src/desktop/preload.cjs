// The desktop app's bridge into Cadence's pages: native features the web UI
// uses when it runs inside the app (and does without in a browser). Pages see
// only these functions, never Electron or Node.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("cadenceDesktop", {
  platform: process.platform,
  /** A folder chosen in the system dialog, or null when cancelled. */
  pickFolder: (title) => ipcRenderer.invoke("cadence:pick-folder", typeof title === "string" ? title : undefined),
  /** The path of a file or folder dropped onto the page. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  /** Opens a path in the system file manager. */
  revealPath: (path) => ipcRenderer.invoke("cadence:reveal-path", String(path)),
  /** Memory in use by every process of the app, in MB. */
  memory: () => ipcRenderer.invoke("cadence:memory"),
  /** The app's version and update state. */
  updateState: () => ipcRenderer.invoke("cadence:update-state"),
  checkForUpdates: () => ipcRenderer.invoke("cadence:check-updates"),
  installUpdate: () => ipcRenderer.invoke("cadence:install-update"),
  /** Menu commands (settings, keyboard shortcuts) and update news; returns an unsubscribe function. */
  onEvent: (callback) => {
    const listener = (_e, event) => callback(event);
    ipcRenderer.on("cadence:event", listener);
    return () => ipcRenderer.removeListener("cadence:event", listener);
  },
});
