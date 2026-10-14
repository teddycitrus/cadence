import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChromeConnection, electronHost } from "../src/browser/chrome";
import { removeTempDir } from "./helpers/temp-dir";

// Machines without Chrome or Edge use Electron's own Chromium. Forced here, so it is
// covered even where Chrome is installed.
describe.skipIf(!electronHost())("browser engine without Chrome", { timeout: 60_000 }, () => {
  const saved = process.env.CADENCE_BROWSER;
  let conn: ChromeConnection | null = null;
  let profile = "";
  afterEach(async () => {
    process.env.CADENCE_BROWSER = saved;
    if (saved === undefined) delete process.env.CADENCE_BROWSER;
    await conn?.close();
    conn = null;
    removeTempDir(profile);
  });

  it("opens tabs through the host, renders at the exact size asked for, and closes them", async () => {
    process.env.CADENCE_BROWSER = "electron";
    profile = mkdtempSync(join(tmpdir(), "cadence-electron-browser-"));
    conn = await ChromeConnection.launch(profile);
    expect(conn.electron).toBe(true);
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await conn.send("Page.enable", {}, sessionId);
    await conn.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 200, deviceScaleFactor: 1, mobile: false }, sessionId);
    await conn.send("Page.navigate", { url: "data:text/html,<body style='margin:0;background:rgb(255,0,0)'></body>" }, sessionId);
    await new Promise((r) => setTimeout(r, 500));
    const { data } = await conn.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
    const png = Buffer.from(data, "base64");
    // PNG width and height sit at bytes 16 and 20 of the header.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 200]);
    await conn.send("Browser.setDownloadBehavior", { behavior: "deny" });
    expect(await conn.send("Target.closeTarget", { targetId })).toEqual({ success: true });
  });
});
