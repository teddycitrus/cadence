import { afterEach, describe, expect, it } from "vitest";
import type { FakeRuntime } from "./helpers/fake-runtime";
import { until } from "./helpers/fake-runtime";
import { bootTeam } from "./helpers/team";

describe("forking and exporting chats", () => {
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
  });

  it("forks a chat at a message, carries the conversation over, and exports it", async () => {
    const team = await bootTeam();
    close = team.close;
    const { c } = team;
    const ws = await c.workspaces.createInProject(null, "Ideas", "user");
    const chat = c.engine.createChat({ workspaceId: ws.id, title: "Pricing" });
    const add = (item: Record<string, unknown>) => c.store.append({ aggregate: "chat", type: "ChatItemAdded", aggregateId: chat.id, payload: { item: item as never } }, "system");
    add({ kind: "user", text: "Plan the pricing page", attachments: [], author: "user", steer: false });
    add({ kind: "assistant", text: "Three tiers." });
    add({ kind: "user", text: "Make it two", attachments: [], author: "user", steer: false });
    add({ kind: "assistant", text: "Two tiers." });
    const at = c.q.chatItems(chat.id)[1]!.seq;

    const forked = await team.local("POST", `/chats/${chat.id}/fork`, { upToSeq: at });
    expect(forked.status).toBe(201);
    expect(forked.json).toMatchObject({ title: "Pricing (fork)", workspaceId: ws.id, carryOver: true, forkedFrom: chat.id });
    const copied = c.q.chatItems(forked.json.id).map((i) => (i.kind === "notice" ? "notice" : i.kind === "user" || i.kind === "assistant" ? i.text : i.kind));
    expect(copied).toEqual(["Plan the pricing page", "Three tiers.", "notice"]);

    // Its first session is told the conversation so far, as a fork.
    const runtime = c.runtime as FakeRuntime;
    runtime.next(async () => "ok");
    await c.engine.send(forked.json.id, { text: "Go on" });
    await until(() => runtime.sessions.length === 1);
    expect(runtime.sessions[0]!.options.instructions).toContain("This chat is a fork of an earlier conversation");
    expect(runtime.sessions[0]!.options.instructions).toContain("Three tiers.");
    expect(runtime.sessions[0]!.options.instructions).not.toContain("Two tiers.");

    const res = await fetch(team.localBase + `/chats/${chat.id}/export`);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Pricing.md"');
    const md = await res.text();
    expect(md).toContain("# Pricing");
    expect(md).toContain("## You\n\nMake it two");
    expect((await team.local("POST", `/chats/${chat.id}/fork`, { upToSeq: 0 })).status).toBe(400);
  });

  it("turns Remote Control on for Claude Code sessions", async () => {
    const team = await bootTeam();
    close = team.close;
    const ws = await team.c.workspaces.createInProject(null, "Remote", "user");
    const chat = team.c.engine.createChat({ workspaceId: ws.id });
    expect((await team.local("PATCH", `/chats/${chat.id}`, { remoteControl: true })).json.remoteControl).toBe(true);
    const runtime = team.c.runtime as FakeRuntime;
    runtime.next(async () => "ok");
    await team.c.engine.send(chat.id, { text: "hi" });
    await until(() => runtime.sessions.length === 1);
    expect(runtime.sessions[0]!.options.remoteControl).toBe(true);
  });
});
