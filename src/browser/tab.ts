import { BrowserError, type ChromeConnection } from "./chrome";

export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  width: number;
  height: number;
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  at: string;
}

/** An interactive element on the page, numbered so agents can act on it. */
export interface PageElement {
  ref: number;
  tag: string;
  role: string;
  name: string;
  type: string | null;
  value: string | null;
}

export type FrameListener = (jpeg: Buffer, meta: { width: number; height: number }) => void;
export type StateListener = (state: BrowserState) => void;

const CONSOLE_KEEP = 300;

/** What the address bar accepts: http(s) and about:blank; bare hosts get a scheme. */
export function normalizeUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new BrowserError("Enter an address");
  if (raw === "about:blank") return raw;
  // "localhost:3000" looks like a scheme to URL(), so local hosts are checked first.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(raw);
  const hasScheme = !local && (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(javascript|data|about|mailto|blob|file|chrome|vbscript):/i.test(raw));
  const withScheme = hasScheme ? raw : `${local ? "http" : "https"}://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new BrowserError(`"${raw}" is not an address`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrowserError(`The built-in browser only opens http and https pages, not ${url.protocol}`);
  return url.href;
}

// Numbers interactive elements in the page (data-cadence-ref) and describes them.
const ELEMENTS_SCRIPT = `(() => {
  const sel = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
  const out = [];
  let ref = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
    ref++;
    el.setAttribute("data-cadence-ref", String(ref));
    const label = el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.getAttribute("alt") || el.getAttribute("name") || "";
    out.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", name: String(label).trim().replace(/\\s+/g, " ").slice(0, 80), type: el.getAttribute("type"), value: "value" in el && el.type !== "password" ? String(el.value).slice(0, 80) : null });
    if (out.length >= 200) break;
  }
  return out;
})()`;

/**
 * One workspace's tab in the built-in browser: people see it streamed into
 * the workspace panel and drive it with mouse and keyboard; agents drive the
 * same tab with tools.
 */
export class BrowserTab {
  state: BrowserState = { url: "about:blank", title: "", canGoBack: false, canGoForward: false, loading: false, width: 1280, height: 800 };
  readonly console: ConsoleEntry[] = [];
  private frames = new Set<FrameListener>();
  private states = new Set<StateListener>();
  private offs: (() => void)[] = [];
  private casting = false;
  closed = false;

  constructor(
    private chrome: ChromeConnection,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserError("This browser tab was closed"));
    return this.chrome.send<T>(method, params, this.sessionId);
  }

  private listen(method: string, fn: (p: Record<string, any>) => void): void {
    this.offs.push(this.chrome.on(method, (p, sid) => sid === this.sessionId && fn(p)));
  }

  async init(): Promise<void> {
    this.listen("Page.frameNavigated", (p) => {
      if (!p.frame.parentId) void this.refresh();
    });
    this.listen("Page.navigatedWithinDocument", () => void this.refresh());
    this.listen("Page.frameStartedLoading", (p) => p.frameId === this.targetId && this.update({ loading: true }));
    // Same-document navigations start loading but never fire a load event.
    this.listen("Page.frameStoppedLoading", (p) => p.frameId === this.targetId && this.update({ loading: false }));
    this.listen("Page.loadEventFired", () => void this.refresh({ loading: false }));
    this.listen("Runtime.consoleAPICalled", (p) => {
      const text = (p.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : (a.description ?? ""))).join(" ");
      const level = p.type === "warning" ? "warn" : ["log", "info", "warn", "error", "debug"].includes(p.type) ? p.type : "log";
      this.log(level, text);
    });
    this.listen("Runtime.exceptionThrown", (p) => this.log("error", p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "Uncaught error"));
    // Alerts and confirms would freeze the page; answer them and note it.
    this.listen("Page.javascriptDialogOpening", (p) => {
      this.log("warn", `${p.type} dialog: ${p.message}`);
      void this.send("Page.handleJavaScriptDialog", { accept: p.type !== "beforeunload" ? p.type === "alert" : true }).catch(() => undefined);
    });
    this.listen("Page.screencastFrame", (p) => {
      void this.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
      const jpeg = Buffer.from(p.data as string, "base64");
      for (const f of this.frames) f(jpeg, { width: p.metadata.deviceWidth, height: p.metadata.deviceHeight });
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.resize(this.state.width, this.state.height);
  }

  private log(level: ConsoleEntry["level"], text: string): void {
    this.console.push({ level, text: text.slice(0, 2000), at: new Date().toISOString() });
    if (this.console.length > CONSOLE_KEEP) this.console.splice(0, this.console.length - CONSOLE_KEEP);
  }

  private update(patch: Partial<BrowserState>): void {
    this.state = { ...this.state, ...patch };
    for (const s of this.states) s(this.state);
  }

  private async refresh(patch: Partial<BrowserState> = {}): Promise<void> {
    try {
      const h = await this.send<{ currentIndex: number; entries: { url: string; title: string }[] }>("Page.getNavigationHistory");
      const entry = h.entries[h.currentIndex];
      this.update({ ...patch, url: entry?.url ?? this.state.url, title: entry?.title ?? "", canGoBack: h.currentIndex > 0, canGoForward: h.currentIndex < h.entries.length - 1 });
    } catch {
      this.update(patch);
    }
  }

  /** Waits for the next load to finish (or the timeout), whichever is first. */
  private loaded(timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve) => {
      const off = this.chrome.on("Page.loadEventFired", (_p, sid) => sid === this.sessionId && done());
      const timer = setTimeout(() => done(), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
    });
  }

  async navigate(input: string): Promise<BrowserState> {
    const url = normalizeUrl(input);
    const loaded = this.loaded();
    const r = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (r.errorText) throw new BrowserError(`Could not open ${url}: ${r.errorText}`);
    await loaded;
    await this.refresh({ loading: false });
    return this.state;
  }

  async history(step: -1 | 1): Promise<BrowserState> {
    const h = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    const entry = h.entries[h.currentIndex + step];
    if (!entry) return this.state;
    const loaded = this.loaded(10_000);
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await loaded;
    await this.refresh({ loading: false });
    return this.state;
  }

  async reload(): Promise<BrowserState> {
    const loaded = this.loaded();
    await this.send("Page.reload", {});
    await loaded;
    await this.refresh({ loading: false });
    return this.state;
  }

  async resize(width: number, height: number): Promise<void> {
    const w = Math.round(Math.min(2560, Math.max(320, width)));
    const h = Math.round(Math.min(1600, Math.max(240, height)));
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    this.update({ width: w, height: h });
    if (this.casting) await this.restartCast();
  }

  async screenshot(): Promise<Buffer> {
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    return Buffer.from(shot.data, "base64");
  }

  mouse(event: { type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button?: "left" | "right" | "middle" | "none"; clickCount?: number; modifiers?: number }): Promise<unknown> {
    return this.send("Input.dispatchMouseEvent", { button: "none", clickCount: 0, ...event });
  }

  wheel(x: number, y: number, deltaX: number, deltaY: number): Promise<unknown> {
    return this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  key(event: { type: "keyDown" | "keyUp" | "rawKeyDown" | "char"; key: string; code?: string; text?: string; keyCode?: number; modifiers?: number }): Promise<unknown> {
    const { keyCode, ...rest } = event;
    return this.send("Input.dispatchKeyEvent", { ...rest, ...(keyCode ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode } : {}) });
  }

  insertText(text: string): Promise<unknown> {
    return this.send("Input.insertText", { text });
  }

  async press(key: "Enter" | "Tab" | "Escape" | "Backspace" | "ArrowDown" | "ArrowUp"): Promise<void> {
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
    await this.key({ type: "rawKeyDown", key, code: key, keyCode: codes[key], ...(key === "Enter" ? { text: "\r" } : {}) });
    if (key === "Enter") await this.key({ type: "char", key, text: "\r" });
    await this.key({ type: "keyUp", key, code: key, keyCode: codes[key] });
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new BrowserError(r.exceptionDetails.text);
    return r.result.value as T;
  }

  /** The page's readable text. */
  async text(maxChars = 20_000): Promise<string> {
    const t = await this.evaluate<string>("document.body ? document.body.innerText : ''");
    return t.length > maxChars ? `${t.slice(0, maxChars)}\n[cut]` : t;
  }

  /** Finds text in the page (like Ctrl+F): selects the next match and counts them all. */
  async find(text: string, backwards = false): Promise<{ found: boolean; count: number }> {
    const q = JSON.stringify(text.slice(0, 200));
    return this.evaluate<{ found: boolean; count: number }>(
      `(() => { const t = ${q}; if (!t) return { found: false, count: 0 }; const body = (document.body && document.body.innerText || "").toLowerCase(); let n = 0; for (let i = body.indexOf(t.toLowerCase()); i >= 0; i = body.indexOf(t.toLowerCase(), i + t.length)) n++; const found = n > 0 && window.find(t, false, ${backwards ? "true" : "false"}, true, false, false, false); return { found, count: n }; })()`,
    );
  }

  /** Numbers the page's interactive elements for clickRef and fill. */
  elements(): Promise<PageElement[]> {
    return this.evaluate<PageElement[]>(ELEMENTS_SCRIPT);
  }

  private async center(ref: number): Promise<{ x: number; y: number }> {
    const r = await this.evaluate<{ x: number; y: number } | null>(`(() => { const el = document.querySelector('[data-cadence-ref="${Number(ref)}"]'); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!r) throw new BrowserError(`No element ${ref} on the page; list elements again, the page may have changed`);
    return r;
  }

  async click(x: number, y: number): Promise<void> {
    await this.mouse({ type: "mouseMoved", x, y });
    await this.mouse({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.mouse({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async clickRef(ref: number): Promise<void> {
    const { x, y } = await this.center(ref);
    await this.click(x, y);
  }

  /** Replaces a field's text, optionally pressing Enter after. */
  async fill(ref: number, text: string, submit = false): Promise<void> {
    await this.clickRef(ref);
    await this.evaluate(`(() => { const el = document.querySelector('[data-cadence-ref="${Number(ref)}"]'); if (el && "select" in el) el.select(); else if (el) document.execCommand("selectAll"); return true; })()`);
    await this.insertText(text);
    if (submit) await this.press("Enter");
  }

  private castChain: Promise<unknown> = Promise.resolve();

  /** (Re)starts the screencast at the current size. Runs one at a time, since start/stop calls must not interleave. */
  private restartCast(): Promise<void> {
    const run = async () => {
      await this.send("Page.stopScreencast").catch(() => undefined);
      if (!this.casting) return;
      await this.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: this.state.width, maxHeight: this.state.height, everyNthFrame: 1 });
    };
    const next = this.castChain.then(run, run);
    this.castChain = next.catch(() => undefined);
    return next;
  }

  /** Streams frames to `onFrame` (and state changes to `onState`) until the returned function is called. */
  watch(onFrame: FrameListener, onState: StateListener): () => void {
    this.frames.add(onFrame);
    this.states.add(onState);
    if (!this.casting) {
      this.casting = true;
      void this.restartCast().catch(() => (this.casting = false));
    }
    onState(this.state);
    return () => {
      this.frames.delete(onFrame);
      this.states.delete(onState);
      if (!this.frames.size && this.casting) {
        this.casting = false;
        void this.send("Page.stopScreencast").catch(() => undefined);
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.offs) off();
    this.frames.clear();
    this.states.clear();
    await this.chrome.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }
}
