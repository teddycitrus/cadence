// A browser engine for machines without Chrome or Edge: Electron's own Chromium.
// Started by the server (src/browser/chrome.ts) with a DevTools port, like
// headless Chrome. DevTools cannot create tabs in Electron, so the server asks
// over IPC and this process opens an offscreen window and answers with its
// DevTools target id; everything else goes over DevTools as with Chrome.
// Offscreen windows render at exactly the size asked for, whatever the display
// scaling, so screenshots and visual checks stay pixel-stable.
const { app, BrowserWindow, session } = require("electron");

// The pages here are the user's app and the web, not Cadence; Electron's warnings about them
// would only fill their consoles.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

app.commandLine.appendSwitch("remote-debugging-port", "0");
app.commandLine.appendSwitch("mute-audio");
app.dock?.hide();
// Windows come and go on request; the host lives until the server ends it.
app.on("window-all-closed", () => {});

const windows = new Map();
let downloads = "deny";

async function open(url) {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await win.loadURL(url || "about:blank").catch(() => undefined);
  win.webContents.debugger.attach("1.3");
  const { targetInfo } = await win.webContents.debugger.sendCommand("Target.getTargetInfo");
  win.webContents.debugger.detach();
  windows.set(targetInfo.targetId, win);
  win.on("closed", () => windows.delete(targetInfo.targetId));
  return targetInfo.targetId;
}

app.whenReady().then(() => {
  session.defaultSession.on("will-download", (_e, item) => {
    if (downloads === "deny") item.cancel();
  });
  process.on("message", async (m) => {
    try {
      if (m.op === "open") return process.send({ id: m.id, result: { targetId: await open(m.url) } });
      if (m.op === "close") {
        windows.get(m.targetId)?.destroy();
        return process.send({ id: m.id, result: { success: true } });
      }
      if (m.op === "downloads") {
        downloads = m.behavior === "deny" ? "deny" : "allow";
        return process.send({ id: m.id, result: {} });
      }
      process.send({ id: m.id, error: `Unknown request ${m.op}` });
    } catch (err) {
      process.send({ id: m.id, error: err instanceof Error ? err.message : String(err) });
    }
  });
  // The server going away ends the host.
  process.on("disconnect", () => app.quit());
});
