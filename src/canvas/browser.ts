import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserError, ChromeConnection } from "../browser/chrome";

export { BrowserError, findChrome } from "../browser/chrome";

/**
 * Runs in the rendered page: a copy of the DOM with every stylesheet inlined
 * (cross-origin ones kept as @import), no scripts, no Cadence markers, form
 * values kept, and links and images pointed at absolute URLs.
 */
const SNAPSHOT = `(() => {
  const imports = [], rules = [];
  for (const sheet of document.styleSheets) {
    try { rules.push([...sheet.cssRules].map((r) => r.cssText).join("\\n")); }
    catch { if (sheet.href) imports.push('@import url("' + sheet.href + '");'); }
  }
  const live = [...document.querySelectorAll("input, textarea, select")];
  const root = document.documentElement.cloneNode(true);
  const copies = [...root.querySelectorAll("input, textarea, select")];
  live.forEach((el, i) => {
    const c = copies[i];
    if (!c) return;
    if (el.type === "checkbox" || el.type === "radio") { if (el.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked"); }
    else if (el.tagName === "TEXTAREA") c.textContent = el.value;
    else if (el.tagName === "SELECT") [...c.options].forEach((o, j) => { if (el.options[j] && el.options[j].selected) o.setAttribute("selected", ""); else o.removeAttribute("selected"); });
    else c.setAttribute("value", el.value);
  });
  root.querySelectorAll('script, noscript, style, link[rel="stylesheet"], link[rel="modulepreload"], link[rel="preload"], vite-error-overlay, [data-cadence-overlay]').forEach((n) => n.remove());
  for (const el of root.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (a.name.startsWith("data-cadence") || a.name.startsWith("on")) el.removeAttribute(a.name);
    for (const a of ["src", "href", "poster"]) {
      const v = el.getAttribute(a);
      if (v && !v.startsWith("#") && !/^(data|blob|javascript|mailto|tel):/i.test(v)) { try { el.setAttribute(a, new URL(v, location.href).href); } catch {} }
    }
    if (el.getAttribute("href") && /^javascript:/i.test(el.getAttribute("href"))) el.removeAttribute("href");
  }
  const style = document.createElement("style");
  style.textContent = imports.concat(rules).join("\\n");
  (root.querySelector("head") || root).appendChild(style);
  return "<!doctype html>\\n" + root.outerHTML;
})()`;

/**
 * A private headless Chrome (throwaway profile) driven over the DevTools
 * protocol, used to capture frames for thumbnails, agent screenshots,
 * snapshots, and visual regression.
 */
export class HeadlessBrowser {
  private chrome: ChromeConnection | null = null;
  private profile: string | null = null;
  private starting: Promise<ChromeConnection> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private connection(): Promise<ChromeConnection> {
    if (this.chrome && !this.chrome.closed) return Promise.resolve(this.chrome);
    this.starting ??= (async () => {
      this.profile = mkdtempSync(join(tmpdir(), "cadence-chrome-"));
      const chrome = await ChromeConnection.launch(this.profile, ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"]);
      chrome.onClose(() => {
        this.chrome = null;
        this.starting = null;
      });
      this.chrome = chrome;
      return chrome;
    })().catch((err) => {
      this.starting = null;
      throw err instanceof BrowserError ? err : new BrowserError(String(err));
    });
    return this.starting;
  }

  /** Resolves on the next event for a tab, or after the timeout. */
  private once(chrome: ChromeConnection, method: string, sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = chrome.on(method, (_p, sid) => sid === sessionId && done());
      const timer = setTimeout(done, timeoutMs);
    });
  }

  /** Loads `url` at exactly width x height CSS pixels in a fresh tab, then runs `fn` on it. Runs one at a time. */
  private withPage<T>(url: string, width: number, height: number, settleMs: number, fn: (chrome: ChromeConnection, sessionId: string) => Promise<T>): Promise<T> {
    const run = async () => {
      const chrome = await this.connection();
      const { targetId } = await chrome.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await chrome.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      try {
        await chrome.send("Page.enable", {}, sessionId);
        await chrome.send("Emulation.setDeviceMetricsOverride", { width: Math.round(width), height: Math.round(height), deviceScaleFactor: 1, mobile: false }, sessionId);
        const loaded = this.once(chrome, "Page.loadEventFired", sessionId, 15_000);
        await chrome.send("Page.navigate", { url }, sessionId);
        await loaded;
        await chrome.send("Runtime.evaluate", { expression: "document.fonts ? document.fonts.ready.then(() => true) : true", awaitPromise: true }, sessionId);
        await new Promise((r) => setTimeout(r, settleMs));
        return await fn(chrome, sessionId);
      } finally {
        await chrome.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** PNG of `url` rendered at exactly width x height CSS pixels. */
  capture(url: string, width: number, height: number, settleMs = 400): Promise<Buffer> {
    return this.withPage(url, width, height, settleMs, async (chrome, sessionId) => {
      const shot = await chrome.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: Math.round(width), height: Math.round(height), scale: 1 } }, sessionId);
      return Buffer.from(shot.data, "base64");
    });
  }

  /** The page as it rendered, as one static HTML document (see SNAPSHOT). */
  snapshotHtml(url: string, width: number, height: number): Promise<string> {
    return this.withPage(url, width, height, 400, async (chrome, sessionId) => {
      const r = await chrome.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: SNAPSHOT, returnByValue: true }, sessionId);
      if (typeof r.result.value !== "string") throw new BrowserError("Could not read the rendered page");
      return r.result.value;
    });
  }

  /** Ends Chrome, then removes its throwaway profile (Chrome holds the folder until it exits). */
  async close(): Promise<void> {
    const chrome = this.chrome;
    this.chrome = null;
    const dir = this.profile;
    this.profile = null;
    await chrome?.close();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // a leftover temp folder is harmless
      }
    }
  }
}
