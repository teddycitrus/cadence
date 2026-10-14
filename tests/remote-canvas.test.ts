import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startCadence, type Cadence } from "../src/server/serve";
import { Tunnel } from "../src/sharing/tunnel";
import { FakeRuntime } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

const FAKE = fileURLToPath(new URL("./helpers/fake-cloudflared.mjs", import.meta.url));
const CANVAS = `export default { name: "App" };\nexport const Home = { name: "Home", html: "index.html" };\n`;

describe("canvases for teammates on other computers", { timeout: 90_000 }, () => {
  let c: Cadence | null = null;
  let fx: GitFixture | null = null;
  const dirs: string[] = [];
  afterEach(async () => {
    await c?.close();
    c = null;
    fx?.cleanup();
    fx = null;
    dirs.splice(0).forEach(removeTempDir);
  });

  /** A request with a chosen Host (fetch cannot set one), as a tunnel delivers it. */
  const send = (method: string, path: string, host: string, cookie = "", body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const u = new URL(c!.url);
      const r = request({ host: u.hostname, port: u.port, method, path, headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), Origin: `https://${host}` } }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
      });
      r.on("error", reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });

  it("gives a remote viewer the frame server's own public address, and the host its local one", async () => {
    fx = createGitFixture({ "app.canvas.tsx": CANVAS, "index.html": "<p>hi</p>\n" });
    const dir = mkdtempSync(join(tmpdir(), "cadence-remote-canvas-"));
    dirs.push(dir);
    c = await startCadence({
      dataDir: dir,
      port: 0,
      host: "127.0.0.1",
      apiToken: null,
      trustLocal: true,
      staticDir: null,
      llm: offlineLlm,
      runtimeFor: () => new FakeRuntime(),
      sharing: { binary: async () => process.execPath, makeTunnel: (b, spec) => new Tunnel(b, spec, { prefix: [FAKE], waitForDns: false }) },
    });
    const container = c.orgs.get("default")!.container;
    await container.auth.bootstrapOwner({ email: "owner@example.com", password: "a-long-owner-password" });
    const project = container.agents.addProject({ name: "x", path: fx.repo, baseBranch: "main", githubRepo: null });
    const local = `127.0.0.1:${new URL(c.url).port}`;
    const opened = await send("POST", "/api/canvases/open", local, "", { projectId: project.id, branch: "main" });
    const wsId = opened.json.workspaceId as string;

    // On the host computer: the devserver itself.
    const here = await send("POST", `/api/workspaces/${wsId}/canvas/dev`, local);
    expect(here.status).toBe(200);
    expect(here.json.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const devPort = new URL(here.json.url).port;

    // Through the public address: signed in as a teammate, then a frame address of its own.
    const remote = "team-share.trycloudflare.com";
    expect((await send("POST", `/api/workspaces/${wsId}/canvas/dev`, remote)).status).toBe(401);
    const login = await new Promise<string>((resolve, reject) => {
      const u = new URL(c!.url);
      const r = request({ host: u.hostname, port: u.port, method: "POST", path: "/api/auth/login", headers: { Host: remote, "Content-Type": "application/json" } }, (res) => (res.resume(), resolve(String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0]!)));
      r.on("error", reject);
      r.end(JSON.stringify({ email: "owner@example.com", password: "a-long-owner-password" }));
    });
    expect(login).toMatch(/^cadence_session=/);
    const there = await send("POST", `/api/workspaces/${wsId}/canvas/dev`, remote, login);
    expect(there.status).toBe(200);
    expect(there.json.url).toBe(`https://fake-tunnel-${devPort}.trycloudflare.com`);
    // The canvas list hands out the same address, and the viewer's page may now talk to frames.
    const list = await send("GET", `/api/workspaces/${wsId}/canvas`, remote, login);
    expect(list.json.dev.url).toBe(`https://fake-tunnel-${devPort}.trycloudflare.com`);
    expect((await send("GET", `/api/workspaces/${wsId}/canvas`, local)).json.dev.url).toBe(here.json.url);
    // The selection bridge inside frames now accepts that viewer's Cadence window.
    const bridge = await (await fetch(`${here.json.url}/@cadence/bridge`)).text();
    expect(bridge).toContain(`https://${remote}`);
  });
});
