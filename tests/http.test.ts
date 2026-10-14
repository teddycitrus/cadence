import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/server/app";
import type { Container } from "../src/server/container";
import { makeContainer } from "./helpers/setup";

describe("HTTP API", () => {
  let c: Container;
  let server: Server;
  let base: string;

  const call = async (method: string, path: string, body?: unknown, token = "secret") => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    c = makeContainer().c;
    server = createApp(c, { apiToken: "secret", staticDir: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    c.db.close();
  });

  it("requires the API token", async () => {
    expect((await call("GET", "/api/snapshot", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/api/snapshot")).json.stages.length).toBeGreaterThan(5);
  });

  it("validates input at the boundary", async () => {
    expect((await call("POST", "/api/issues", { title: " " })).status).toBe(400);
    expect((await call("POST", "/api/labels", { name: "x", color: "red" })).status).toBe(400);
    expect((await call("POST", "/api/agents", { name: "Bad", prompt: "x", triggers: [{ kind: "schedule", cron: "every day" }] })).status).toBe(400);
  });

  it("creates agents from templates, disabled until reviewed", async () => {
    const templates = (await call("GET", "/api/templates")).json as unknown as { id: string }[];
    expect(templates.map((t) => t.id)).toContain("bug-squasher");
    const first = await call("POST", "/api/agents/from-template/bug-squasher");
    const second = await call("POST", "/api/agents/from-template/bug-squasher");
    expect(first.json).toMatchObject({ name: "Bug Squasher", enabled: false, templateId: "bug-squasher" });
    expect(second.json.name).toBe("Bug Squasher 2");
    expect((await call("POST", `/api/agents/${first.json.id}/enable`)).json.enabled).toBe(true);
  });

  it("moves issues and maps lifecycle errors to status codes", async () => {
    const issue = await call("POST", "/api/issues", { title: "Dark mode" });
    expect(issue.status).toBe(201);
    const ready = c.q.stage("Ready to Build")!.id;
    expect((await call("POST", `/api/issues/${issue.json.key}/move`, { stageId: ready })).json.stageId).toBe(ready);
    expect((await call("POST", "/api/issues/CAD-999/comments", { body: "x" })).status).toBe(404);
  });

  it("accepts webhook deliveries by secret without the API token", async () => {
    const agent = await call("POST", "/api/agents", { name: "Inbox", prompt: "triage", enabled: true, triggers: [{ kind: "webhook" }] });
    const secret = agent.json.triggers[0].secret as string;
    const bad = await fetch(`${base}/api/hooks/agents/${agent.json.id}/nope`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(404);
    const ok = await fetch(`${base}/api/hooks/agents/${agent.json.id}/${secret}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "Customer: export is broken" });
    expect(ok.status).toBe(202);
    const { runId } = (await ok.json()) as { runId: string };
    expect(c.q.run(runId)!.context).toContain("export is broken");
  });

  it("validates cron expressions without calling a model", async () => {
    const res = await call("POST", "/api/agents/cron-from-text", { text: "0 9 * * 1-5" });
    expect(res.json).toMatchObject({ cron: "0 9 * * 1-5" });
    expect((await call("POST", "/api/agents/cron-from-text", { text: "weekdays at nine" })).status).toBe(400);
  });

  it("creates workspaces and chats, sends messages, and reads the transcript", async () => {
    const ws = await call("POST", "/api/workspaces", { name: "Scratch work" });
    expect(ws.status).toBe(201);
    expect(ws.json.workspace).toMatchObject({ name: "Scratch work", branch: null, projectId: null });
    const chatId = ws.json.chatId as string;
    const chatPath = `/api/chats/${chatId}`;
    expect((await call("POST", `${chatPath}/messages`, { text: "" })).status).toBe(400);
    expect((await call("POST", `${chatPath}/messages`, { text: "hello" })).json).toEqual({ queued: false });
    for (let i = 0; i < 100 && c.q.chat(chatId)!.status !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
    const detail = await call("GET", chatPath);
    expect(detail.json.items.map((i: { kind: string }) => i.kind)).toEqual(["user", "turn"]);
    expect((await call("PATCH", chatPath, { mode: "plan", title: "Renamed" })).json).toMatchObject({ mode: "plan", title: "Renamed" });
    expect((await call("POST", "/api/chats/interactions/nope", { kind: "tool", allow: true })).status).toBe(404);
    const snap = await call("GET", "/api/snapshot");
    expect(snap.json.chats.some((ch: { id: string }) => ch.id === chatId)).toBe(true);
  });

  it("spins off one workspace per issue with the issue attached", async () => {
    const a = await call("POST", "/api/issues", { title: "First" });
    const b = await call("POST", "/api/issues", { title: "Second" });
    const res = await call("POST", "/api/workspaces/from-issues", { issueIds: [a.json.id, b.json.id], prompt: "Investigate this" });
    expect(res.status).toBe(201);
    expect(res.json.created).toHaveLength(2);
    expect(c.q.workspacesForIssue(a.json.id)).toHaveLength(1);
    const items = c.q.chatItems(res.json.created[0].chatId);
    expect(items[0]).toMatchObject({ kind: "user", text: "Investigate this" });
  });
});
