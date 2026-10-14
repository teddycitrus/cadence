import { createHash } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addressedLocally, isLocal } from "../src/server/auth-middleware";
import { startCadence, type Cadence } from "../src/server/serve";
import { assetName, ensureCloudflared } from "../src/sharing/cloudflared";
import { Tunnel } from "../src/sharing/tunnel";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

const FAKE = fileURLToPath(new URL("./helpers/fake-cloudflared.mjs", import.meta.url));
const fakeTunnel = (binary: string, spec: ConstructorParameters<typeof Tunnel>[1]) => new Tunnel(binary, spec, { prefix: [FAKE], waitForDns: false });
const req = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

describe("sharing this computer with teammates elsewhere", { timeout: 60_000 }, () => {
  const dirs: string[] = [];
  const running: Cadence[] = [];
  afterEach(async () => {
    for (const c of running.splice(0)) await c.close();
    delete process.env.FAKE_CLOUDFLARED_LOG;
    delete process.env.FAKE_CLOUDFLARED_FAIL;
    dirs.splice(0).forEach(removeTempDir);
  });
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), "cadence-sharing-"));
    dirs.push(d);
    return d;
  };
  const boot = async (extra: Partial<Parameters<typeof startCadence>[0]> = {}) => {
    const c = await startCadence({
      dataDir: temp(),
      port: 0,
      host: "127.0.0.1",
      apiToken: null,
      trustLocal: true,
      staticDir: null,
      llm: offlineLlm,
      runtimeFor: () => new FakeRuntime(),
      sharing: { binary: async () => process.execPath, makeTunnel: fakeTunnel },
      ...extra,
    });
    running.push(c);
    return c;
  };
  /** fetch drops a Host header (the spec forbids setting it), so requests "through a tunnel" go out with node:http. */
  const viaHost = (c: Cadence, method: string, path: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(c.url);
      const r = request({ host: u.hostname, port: u.port, method, path, headers: { Host: host, "Content-Type": "application/json" } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      r.on("error", reject);
      r.end(method === "POST" ? "{}" : undefined);
    });
  const call = async (c: Cadence, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${c.url}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> };
  };

  it("never treats a request that arrived through a tunnel as the owner", () => {
    expect(isLocal(req("127.0.0.1", { host: "127.0.0.1:4317" }), true)).toBe(true);
    expect(isLocal(req("::1", { host: "localhost:5173" }), true)).toBe(true);
    // cloudflared connects from this machine but keeps the public Host.
    expect(isLocal(req("127.0.0.1", { host: "quiet-river.trycloudflare.com" }), true)).toBe(false);
    expect(isLocal(req("127.0.0.1", { host: "127.0.0.1:4317", "cf-connecting-ip": "203.0.113.9" }), true)).toBe(false);
    expect(isLocal(req("127.0.0.1", { host: "127.0.0.1:4317", "x-forwarded-for": "203.0.113.9" }), true)).toBe(false);
    expect(isLocal(req("192.168.1.20", { host: "127.0.0.1:4317" }), true)).toBe(false);
    expect(addressedLocally(req("127.0.0.1", { host: "[::1]:4317" }))).toBe(true);
  });

  it("starts and stops tunnels and reports cloudflared's own error", async () => {
    const log = join(temp(), "args.log");
    process.env.FAKE_CLOUDFLARED_LOG = log;
    const quick = fakeTunnel(process.execPath, { kind: "quick", port: 4999, hostHeader: "127.0.0.1:4999" });
    expect(await quick.start()).toBe("https://fake-tunnel-4999.trycloudflare.com");
    expect(readFileSync(log, "utf8")).toContain('"--http-host-header","127.0.0.1:4999"');
    await quick.stop();
    expect(quick.running).toBe(false);
    const named = fakeTunnel(process.execPath, { kind: "named", token: "t".repeat(40), url: "https://cadence.example.com" });
    expect(await named.start()).toBe("https://cadence.example.com");
    await named.stop();
    process.env.FAKE_CLOUDFLARED_FAIL = "1";
    await expect(fakeTunnel(process.execPath, { kind: "quick", port: 1 }).start()).rejects.toThrow(/429 Too Many Requests/);
  });

  it("lets only a signed-in-ready owner share, gives teammates the public address, and turns sharing back on after a restart", async () => {
    const c = await boot();
    const off = await call(c, "GET", "/api/sharing");
    expect(off.json).toMatchObject({ state: "off", publicUrl: null, fixed: false, canManage: true });
    // Nobody can be let in before the owner can sign in.
    expect((await call(c, "POST", "/api/sharing/start", { mode: "quick" })).status).toBe(409);
    await c.orgs.get("default")!.container.auth.setPassword("me", "a-long-owner-password");
    const on = await call(c, "POST", "/api/sharing/start", { mode: "quick" });
    const port = new URL(c.url).port;
    expect(on.json).toMatchObject({ state: "on", publicUrl: `https://fake-tunnel-${port}.trycloudflare.com` });
    // A visit through the tunnel must sign in, even though it connects from this machine.
    const tunnelHost = `fake-tunnel-${port}.trycloudflare.com`;
    expect(await viaHost(c, "GET", "/api/snapshot", tunnelHost)).toBe(401);
    expect(await viaHost(c, "POST", "/api/sharing/stop", tunnelHost)).toBe(403);
    expect(await viaHost(c, "GET", "/api/snapshot", `127.0.0.1:${port}`)).toBe(200);
    // Links agents hand out use the public address meanwhile.
    expect(process.env.CADENCE_PUBLIC_URL).toBe(`https://fake-tunnel-${port}.trycloudflare.com`);
    // Frames for remote viewers get tunnels of their own, sending the local Host.
    expect(await c.sharing.frameUrl(5123)).toBe("https://fake-tunnel-5123.trycloudflare.com");
    expect(await c.sharing.frameUrl(5123)).toBe("https://fake-tunnel-5123.trycloudflare.com");

    // Sharing that was on comes back on with the server.
    const dir = (c.sharing as unknown as { o: { dataDir: string } }).o.dataDir;
    await c.close();
    running.splice(running.indexOf(c), 1);
    expect(process.env.CADENCE_PUBLIC_URL).toBeUndefined();
    const again = await boot({ dataDir: dir });
    for (let i = 0; i < 50 && again.sharing.status().state !== "on"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(again.sharing.status().state).toBe("on");
    expect((await call(again, "POST", "/api/sharing/stop")).json).toMatchObject({ state: "off", publicUrl: null });
  });

  it("sets up a team server's owner from its environment and reports its fixed address", async () => {
    const c = await boot({ owner: { email: "Owner@Example.com", password: "team-server-password-1", name: "Ada" }, publicUrl: "https://cadence.example.com/" });
    const status = await call(c, "GET", "/api/sharing");
    expect(status.json).toMatchObject({ state: "on", fixed: true, publicUrl: "https://cadence.example.com" });
    const login = await call(c, "POST", "/api/auth/login", { email: "owner@example.com", password: "team-server-password-1" });
    expect(login.status).toBe(200);
    expect(c.orgs.get("default")!.container.q.member("me")).toMatchObject({ name: "Ada", email: "owner@example.com" });
    // Sharing is the team server's own; nothing to turn on.
    expect((await call(c, "POST", "/api/sharing/start", { mode: "quick" })).json).toMatchObject({ fixed: true });
  });

  it("installs cloudflared from its release only when the download matches GitHub's checksum", async () => {
    const body = Buffer.from("fake cloudflared binary");
    const sha = createHash("sha256").update(body).digest("hex");
    const fakeFetch = (digest: string) =>
      (async (url: string | URL) =>
        String(url).includes("api.github.com")
          ? new Response(JSON.stringify({ assets: [{ name: assetName(), browser_download_url: "https://example.invalid/cloudflared", digest }] }))
          : new Response(new Uint8Array(body))) as typeof fetch;
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      if (assetName().endsWith(".tgz")) return; // macOS releases are archives; covered by the tar path in node-toolchain tests.
      const bad = temp();
      await expect(ensureCloudflared(bad, fakeFetch(`sha256:${"0".repeat(64)}`))).rejects.toThrow(/checksum/);
      await expect(ensureCloudflared(bad, fakeFetch(""))).rejects.toThrow(/no checksum/);
      const good = temp();
      const bin = await ensureCloudflared(good, fakeFetch(`sha256:${sha}`));
      expect(existsSync(bin) && readFileSync(bin).equals(body)).toBe(true);
    } finally {
      process.env.PATH = saved;
    }
  });
});
