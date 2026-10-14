import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startCadence, type Cadence } from "../src/server/serve";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

const HUB_TOKEN = "hub-api-token-for-tests";

async function eventually(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("machines", () => {
  const running: Cadence[] = [];
  const runtimes = new Map<Cadence, FakeRuntime>();
  const dirs: string[] = [];
  afterEach(async () => {
    for (const c of running.splice(0)) await c.close();
    await new Promise((r) => setTimeout(r, 300));
    for (const d of dirs.splice(0)) removeTempDir(d);
  });

  const boot = async (o: { apiToken: string | null; trustLocal: boolean }) => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-machines-"));
    dirs.push(dir);
    const runtime = new FakeRuntime();
    const c = await startCadence({ dataDir: dir, port: 0, host: "127.0.0.1", ...o, staticDir: null, llm: offlineLlm, runtimeFor: () => runtime });
    runtimes.set(c, runtime);
    running.push(c);
    return c;
  };

  const call = async (base: string, method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { text };
    }
    return { status: res.status, json };
  };

  it("connects a machine to a hub and opens its Cadence through a relay", async () => {
    // The hub is reachable from elsewhere, so it does not trust local requests; the machine is a desktop.
    const hub = await boot({ apiToken: HUB_TOKEN, trustLocal: false });
    const machine = await boot({ apiToken: null, trustLocal: true });
    const onHub = (method: string, path: string, body?: unknown) => call(hub.url, method, path, body, HUB_TOKEN);
    const onMachine = (method: string, path: string, body?: unknown) => call(machine.url, method, path, body);

    const added = await onHub("POST", "/api/machines", { name: "Studio desktop" });
    expect(added.status).toBe(201);
    expect(added.json.token).toMatch(/^cdm\.default\./);
    expect(added.json.machine).not.toHaveProperty("tokenHash");
    expect((await call(hub.url, "GET", "/api/machines")).status).toBe(401);

    expect((await onMachine("PUT", "/api/machine-link", { hubUrl: hub.url, token: "nonsense" })).status).toBe(400);
    expect((await onMachine("PUT", "/api/machine-link", { hubUrl: hub.url, token: added.json.token })).json).toMatchObject({ state: "connecting" });
    await eventually(async () => (await onHub("GET", "/api/machines")).json[0]?.online === true);
    const listed = (await onHub("GET", "/api/machines")).json[0];
    expect(listed).toMatchObject({ name: "Studio desktop", platform: process.platform, port: Number(new URL(machine.url).port) });
    expect((await onMachine("GET", "/api/machine-link")).json).toMatchObject({ state: "connected", machineName: "Studio desktop" });

    // Work on the machine shows through the relay, not on the hub.
    await onMachine("POST", "/api/issues", { title: "Only on the desktop", body: "", type: "bug", priority: "low" });
    const opened = await onHub("POST", `/api/machines/${added.json.machine.id}/open`);
    const relay: string = opened.json.url;
    expect(relay).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect((await call(relay, "GET", "api/snapshot")).status).toBe(401);
    const snap = await call(relay, "GET", "api/snapshot", undefined, HUB_TOKEN);
    expect(snap.status).toBe(200);
    expect(snap.json.issues.map((i: { title: string }) => i.title)).toContain("Only on the desktop");
    expect((await onHub("GET", "/api/snapshot")).json.issues.map((i: { title: string }) => i.title)).not.toContain("Only on the desktop");

    // Writes and JSON bodies go through, and URLs to the machine's own ports point at relays.
    const created = await call(relay, "POST", "api/issues", { title: "Filed remotely", body: `see ${machine.url}/x`, type: "feature", priority: "none" }, HUB_TOKEN);
    expect(created.status).toBe(201);
    expect(created.json.body).toBe(`see ${relay.slice(0, -1)}/x`);
    expect((await onMachine("GET", "/api/snapshot")).json.issues.find((i: { title: string }) => i.title === "Filed remotely").body).toBe(`see ${machine.url}/x`);

    // WebSockets pass through too (a doc's live editing socket).
    const doc = await onMachine("POST", "/api/docs", { title: "Notes", kind: "doc", body: "" });
    const socket = new WebSocket(`${relay.replace("http", "ws")}api/docs/${doc.json.id}/collab`, { headers: { Authorization: `Bearer ${HUB_TOKEN}` } });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (_q, res) => reject(new Error(`upgrade ${res.statusCode}`)));
    });
    socket.close();

    // Remote control: what is running and waiting on the machine, approved from the hub.
    const id = added.json.machine.id as string;
    expect((await onHub("GET", `/api/machines/${id}/summary`)).json).toEqual({ workspaces: 0, projects: [], recent: [], runningChats: [], pending: [] });
    const made = await onHub("POST", `/api/machines/${id}/workspaces`, { projectId: null, name: "From the hub" });
    expect(made.status).toBe(201);
    expect(machine.orgs.get("default")!.container.q.workspace(made.json.workspace.id)).toMatchObject({ name: "From the hub" });
    expect(machine.orgs.get("default")!.container.q.chat(made.json.chatId)).toBeTruthy();
    expect((await onHub("PATCH", `/api/machines/${id}`, { name: "Studio" })).json.name).toBe("Studio");
    const desk = machine.orgs.get("default")!.container;
    let allowed: unknown = null;
    runtimes.get(machine)!.next(async (ctx) => {
      allowed = await ctx.approve("Bash", { command: "npm run deploy", description: "Deploy" });
      return "deployed";
    });
    const ws = await desk.workspaces.createInProject(null, "Deploy", "user");
    const chat = desk.engine.createChat({ workspaceId: ws.id, title: "Ship it" });
    await desk.engine.send(chat.id, { text: "deploy" });
    await eventually(async () => (await onHub("GET", `/api/machines/${id}/summary`)).json.pending.length === 1);
    const summary = (await onHub("GET", `/api/machines/${id}/summary`)).json;
    expect(summary).toMatchObject({ workspaces: 2, recent: expect.arrayContaining([expect.objectContaining({ name: "Deploy", chatId: chat.id })]), pending: [{ chatId: chat.id, chatTitle: "Ship it", kind: "tool", title: "Bash", detail: "npm run deploy" }] });
    expect((await onHub("POST", `/api/machines/${id}/interactions/${summary.pending[0].id}`, { kind: "tool", allow: true })).status).toBe(200);
    await eventually(async () => desk.q.chat(chat.id)!.status === "idle");
    expect(allowed).toMatchObject({ allow: true });
    expect((await onHub("POST", `/api/machines/${added.json.machine.id}/interactions/nope`, { kind: "tool", allow: true })).status).toBeGreaterThanOrEqual(400);

    // Removing the machine cuts it off, and its token stops working.
    expect((await onHub("DELETE", `/api/machines/${added.json.machine.id}`)).status).toBe(204);
    await eventually(async () => (await onMachine("GET", "/api/machine-link")).json.state === "error");
    expect((await onMachine("GET", "/api/machine-link")).json.error).toMatch(/refused/);
    // Its relays close with it.
    await expect(fetch(`${relay}api/snapshot`, { headers: { Authorization: `Bearer ${HUB_TOKEN}` } })).rejects.toThrow();
  });

  it("only forwards to ports the machine's Cadence itself points at", async () => {
    const hub = await boot({ apiToken: null, trustLocal: true });
    const machine = await boot({ apiToken: null, trustLocal: true });
    const added = await call(hub.url, "POST", "/api/machines", { name: "Laptop" });
    await call(machine.url, "PUT", "/api/machine-link", { hubUrl: hub.url, token: added.json.token });
    await eventually(async () => (await call(hub.url, "GET", "/api/machines")).json[0]?.online === true);
    // The hub's own port was never advertised by the machine's Cadence, so the machine refuses it.
    const hubPort = Number(new URL(hub.url).port);
    const tunnel = (hub.orgs.get("default")!.container.machines as unknown as { live: Map<string, { tunnel: import("../src/machines/tunnel").Tunnel }> }).live.get(added.json.machine.id)!.tunnel;
    const stream = tunnel.open(hubPort);
    const err = await new Promise<Error>((resolve) => stream.once("error", resolve));
    expect(err.message).toMatch(/not shared/);
    await call(machine.url, "DELETE", "/api/machine-link");
    await eventually(async () => (await call(hub.url, "GET", "/api/machines")).json[0]?.online === false);
  });
});
