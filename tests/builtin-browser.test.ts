import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChrome } from "../src/canvas/browser";
import { BuiltInBrowser } from "../src/browser/service";
import { normalizeUrl } from "../src/browser/tab";
import { browserTools } from "../src/browser/tools";
import { callBoardTool } from "../src/agents/board-tools";
import { attachBrowserSockets } from "../src/server/browser-socket";
import { removeTempDir } from "./helpers/temp-dir";

const PAGE = `<!doctype html><html><head><title>Signup</title></head><body>
<label for="email">Email</label><input id="email" placeholder="you@example.com">
<button id="go" onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('email').value; console.error('clicked with', document.getElementById('email').value)">Sign up</button>
<p id="out"></p>
<a href="/next">Next page</a>
<script>console.log("page ready")</script>
</body></html>`;

describe("address bar", () => {
  it("adds a scheme to bare hosts and refuses non-web schemes", () => {
    expect(normalizeUrl("localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/only opens http/);
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow(/only opens http/);
    expect(() => normalizeUrl("chrome://settings")).toThrow(/only opens http/);
  });
});

describe.runIf(Boolean(findChrome()))("built-in browser", () => {
  let site: Server;
  let base: string;
  let dir: string;
  let browser: BuiltInBrowser;

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(req.url === "/next" ? "<title>Next</title><h1>Second page</h1>" : PAGE);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), "cadence-bb-"));
    browser = new BuiltInBrowser(dir);
  }, 30_000);

  afterAll(async () => {
    await browser.closeAll();
    site.close();
    await new Promise((r) => setTimeout(r, 800));
    try {
      removeTempDir(dir);
    } catch {
      // Under load Windows can keep a just-exited Chrome's profile locked for a while; a leftover temp folder is harmless.
    }
  });

  it("navigates, lists elements, types, clicks, and keeps the console", async () => {
    const tab = await browser.tab("ws-1");
    expect(await browser.tab("ws-1")).toBe(tab);
    const state = await tab.navigate(base);
    expect(state).toMatchObject({ url: `${base}/`, title: "Signup", canGoBack: true });
    const els = await tab.elements();
    expect(els.map((e) => [e.tag, e.name])).toEqual([
      ["input", "Email"],
      ["button", "Sign up"],
      ["a", "Next page"],
    ]);
    await tab.fill(1, "ada@example.com");
    await tab.clickRef(2);
    await new Promise((r) => setTimeout(r, 200));
    expect(await tab.text()).toContain("Hello ada@example.com");
    expect(tab.console.map((c) => [c.level, c.text])).toEqual([
      ["log", "page ready"],
      ["error", "clicked with ada@example.com"],
    ]);
    await tab.clickRef(3);
    await new Promise((r) => setTimeout(r, 500));
    expect(tab.state).toMatchObject({ url: `${base}/next`, title: "Next" });
    await tab.history(-1);
    expect(tab.state.url).toBe(`${base}/`);
    const png = await tab.screenshot();
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // Each workspace has its own tab.
    expect(await browser.tab("ws-2")).not.toBe(tab);
  }, 60_000);

  it("gives agents the same tab as tools", async () => {
    const tools = browserTools(browser);
    const ctx = { actor: "user" as const, runId: null, issueId: null, workspaceId: "ws-3" };
    expect((await callBoardTool(tools, "browser_open", { url: base }, ctx)).text).toBe(`Opened Signup at ${base}/.`);
    expect((await callBoardTool(tools, "browser_elements", {}, ctx)).text).toContain(`[1] input "Email"`);
    await callBoardTool(tools, "browser_type", { element: 1, text: "grace" }, ctx);
    await callBoardTool(tools, "browser_click", { element: 2 }, ctx);
    expect((await callBoardTool(tools, "browser_read", {}, ctx)).text).toContain("Hello grace");
    expect((await callBoardTool(tools, "browser_console", { errors_only: true }, ctx)).text).toMatch(/error: clicked with grace/);
    const shot = await callBoardTool(tools, "browser_screenshot", {}, ctx);
    expect(shot.images?.[0]?.mimeType).toBe("image/png");
    expect((await callBoardTool(tools, "browser_open", { url: "file:///c:/" }, ctx)).isError).toBe(true);
    expect((await callBoardTool(tools, "browser_read", {}, { ...ctx, workspaceId: null })).isError).toBe(true);
  }, 60_000);

  it("streams frames and state over the socket and takes input from it", async () => {
    const server = createServer();
    const workspaces = { workspaceOrThrow: (id: string) => (id === "ws-4" ? {} : (() => { throw new Error("nope"); })()) };
    attachBrowserSockets(server, browser, workspaces as never, () => true);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws-4/browser/socket`;
    const ws = new WebSocket(url);
    const states: { url: string }[] = [];
    let frames = 0;
    const errors: string[] = [];
    ws.on("message", (data, binary) => {
      if (binary) frames++;
      else {
        const m = JSON.parse(String(data));
        if (m.type === "state") states.push(m.state);
        if (m.type === "error") errors.push(m.message);
      }
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "navigate", url: base }));
    const deadline = Date.now() + 15_000;
    while ((frames === 0 || !states.some((s) => s.url === `${base}/`)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(errors).toEqual([]);
    expect(frames).toBeGreaterThan(0);
    expect(states.at(-1)).toMatchObject({ url: `${base}/` });
    ws.close();
    // Unknown workspaces are refused.
    const bad = new WebSocket(url.replace("ws-4", "ws-9"));
    await expect(new Promise((resolve, reject) => (bad.once("open", resolve), bad.once("error", reject)))).rejects.toThrow(/404/);

    // A second tab is separate from the agents' tab, and closes for good.
    const second = new WebSocket(`${url}?tab=2`);
    const tabs: number[][] = [];
    second.on("message", (data, binary) => {
      if (!binary && JSON.parse(String(data)).type === "tabs") tabs.push(JSON.parse(String(data)).open);
    });
    await new Promise((r) => second.once("open", r));
    second.send(JSON.stringify({ type: "navigate", url: `${base}/next` }));
    second.send(JSON.stringify({ type: "tabs" }));
    while (!tabs.length && Date.now() < deadline + 15_000) await new Promise((r) => setTimeout(r, 100));
    expect(tabs[0]).toEqual([0, 2]);
    expect((await browser.tab("ws-4")).state.url).toBe(`${base}/`);
    second.send(JSON.stringify({ type: "close" }));
    await new Promise((r) => second.once("close", r));
    expect(browser.open("ws-4")).toEqual([0]);
    const tooMany = new WebSocket(`${url}?tab=8`);
    await expect(new Promise((resolve, reject) => (tooMany.once("open", resolve), tooMany.once("error", reject)))).rejects.toThrow(/400/);
    server.close();
  }, 60_000);
});
