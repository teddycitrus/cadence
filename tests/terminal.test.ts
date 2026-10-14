import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/server/app";
import { createContainer, type Container } from "../src/server/container";
import { attachTerminalSockets } from "../src/server/terminal-socket";
import { identify } from "../src/server/auth-middleware";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

describe("terminals", () => {
  let fx: GitFixture;
  let c: Container;
  let server: Server;
  let port: number;

  const boot = async (apiToken: string | null = null) => {
    fx = createGitFixture();
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
    c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null });
    server = createApp(c, { apiToken, staticDir: null }).listen(0, "127.0.0.1");
    attachTerminalSockets(server, c.terminals, (req) => Boolean(identify(req, c.auth, { apiToken, trustLocal: !apiToken })));
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
    return c.workspaces.createInProject(c.q.projects()[0]!.id, "term", "user");
  };

  afterEach(async () => {
    c.stop();
    server.close();
    c.db.close();
    // A shell holds its folder open on Windows until it has really exited.
    await c.terminals.exited();
    fx.cleanup();
  });

  const connect = (id: string, headers: Record<string, string> = {}, query = "") =>
    new Promise<{ ws: WebSocket; frames: { type: string; data?: string }[] }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}/socket${query}`, { headers });
      const frames: { type: string; data?: string }[] = [];
      ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
      ws.once("open", () => resolve({ ws, frames }));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });

  it("runs a real shell in the workspace and streams it over a socket", async () => {
    const ws = await boot();
    const term = await c.terminals.open(ws.id, { cols: 80, rows: 24 });
    const { ws: sock, frames } = await connect(term.id);
    expect(frames[0]?.type).toBe("snapshot");
    sock.send(JSON.stringify({ type: "input", data: "echo cadence-$((6*7))\r".replace("$((6*7))", process.platform === "win32" ? "$(6*7)" : "$((6*7))") }));
    sock.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    const text = () => frames.map((f) => f.data ?? "").join("");
    await until(() => text().includes("cadence-42"), 15_000);

    // A second tab reconnecting sees the scrollback.
    const again = await connect(term.id);
    await until(() => again.frames.length > 0);
    expect(again.frames[0]!.data).toContain("cadence-42");

    sock.close();
    again.ws.close();
    c.terminals.close(term.id);
    expect(c.terminals.list(ws.id)).toEqual([]);
  });

  it("refuses sockets from other websites and without the API token", async () => {
    const ws = await boot("secret");
    const term = await c.terminals.open(ws.id);
    await expect(connect(term.id, { Origin: "https://evil.example" }, "?token=secret")).rejects.toThrow("HTTP 403");
    await expect(connect(term.id)).rejects.toThrow("HTTP 401");
    await expect(connect("00000000-0000-0000-0000-000000000000", {}, "?token=secret")).rejects.toThrow("HTTP 404");
    const ok = await connect(term.id, { Origin: `http://127.0.0.1:${port}` }, "?token=secret");
    ok.ws.close();
    // Many refusals at once still each get their status, never a dropped connection.
    const many = await Promise.allSettled(Array.from({ length: 40 }, () => connect(term.id, { Origin: "https://evil.example" }, "?token=secret")));
    expect(many.map((r) => (r.status === "rejected" ? String((r.reason as Error).message) : "opened"))).toEqual(Array(40).fill("HTTP 403"));
  });

  it("reports when closed shells have exited, after which their folder can be deleted", async () => {
    const ws = await boot();
    const term = await c.terminals.open(ws.id);
    expect(term.alive).toBe(true);
    c.terminals.closeWorkspace(ws.id);
    const t = Date.now();
    await c.terminals.exited();
    expect(Date.now() - t).toBeLessThan(3000);
    expect(() => rmSync(ws.path, { recursive: true, force: true })).not.toThrow();
  });

  it("runs a project command in a new terminal and closes terminals when the workspace is archived", async () => {
    const ws = await boot();
    const term = await c.terminals.open(ws.id, { command: "git status --short --branch" });
    expect(term.title).toBe("git status --short --branch");
    const { frames } = await connect(term.id);
    await until(() => frames.map((f) => f.data ?? "").join("").includes("## "), 15_000);
    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/${ws.id}/archive`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(c.terminals.list(ws.id)).toEqual([]);
  });
});
