import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

/** Plays Slack: the Web API over fetch and the Socket Mode end of a WebSocket. */
class FakeSlack {
  wss = new WebSocketServer({ port: 0 });
  sockets: WebSocket[] = [];
  acks: string[] = [];
  posts: { channel: string; text: string; thread_ts?: string }[] = [];
  reactions: { channel: string; timestamp: string; name: string }[] = [];
  opens = 0;
  thread: { ts: string; user?: string; text: string }[] = [];

  constructor() {
    this.wss.on("connection", (ws) => {
      this.sockets.push(ws);
      ws.on("message", (raw) => this.acks.push((JSON.parse(String(raw)) as { envelope_id: string }).envelope_id));
      ws.send(JSON.stringify({ type: "hello" }));
    });
  }

  get url() {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }

  fetch: typeof fetch = async (input, init) => {
    const method = new URL(String(input)).pathname.replace("/api/", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    const ok = (data: Record<string, unknown> = {}) => new Response(JSON.stringify({ ok: true, ...data }));
    switch (method) {
      case "auth.test":
        return ok({ team: "Acme", team_id: "T1", user_id: "UBOT", url: "https://acme.slack.com/" });
      case "apps.connections.open":
        this.opens++;
        return ok({ url: this.url });
      case "users.info":
        return ok({ user: { name: "dana", profile: { display_name: "Dana" } } });
      case "chat.postMessage":
        this.posts.push({ channel: body.channel!, text: body.text!, thread_ts: body.thread_ts });
        return ok({ ts: "1700000000.000900", channel: body.channel });
      case "reactions.add":
        this.reactions.push({ channel: body.channel!, timestamp: body.timestamp!, name: body.name! });
        return ok();
      case "conversations.replies":
        return ok({ messages: this.thread });
      default:
        return new Response(JSON.stringify({ ok: false, error: "unknown_method" }));
    }
  };

  /** Pushes an Events API event to every connected socket. */
  emit(event: Record<string, unknown>, id = `E${Math.random().toString(36).slice(2)}`) {
    for (const ws of this.sockets) ws.send(JSON.stringify({ type: "events_api", envelope_id: `env-${id}`, payload: { event_id: id, event } }));
  }
}

describe("Slack", () => {
  let fx: GitFixture;
  let c: Container;
  let slack: FakeSlack;
  let runtime: FakeRuntime;

  const boot = async () => {
    fx = createGitFixture();
    slack = new FakeSlack();
    runtime = new FakeRuntime();
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime, llm: offlineLlm, fetchImpl: slack.fetch });
    c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null });
    c.start();
    await c.slack.connect("xoxb-test-token", "xapp-test-token");
    await until(() => c.slack.status().connection === "connected");
  };

  afterEach(async () => {
    c.stop();
    await c.queue.whenIdle();
    c.db.close();
    slack.wss.close();
    fx.cleanup();
  });

  it("rejects tokens of the wrong kind and never returns saved tokens", async () => {
    await boot();
    await expect(c.slack.connect("xapp-wrong", "xapp-x")).rejects.toThrow(/xoxb-/);
    const status = c.slack.status();
    expect(status).toMatchObject({ configured: true, connection: "connected", team: "Acme", botUserId: "UBOT" });
    expect(JSON.stringify(status)).not.toContain("xoxb");
  });

  it("starts a workspace chat from a mention, acks every envelope, and routes thread replies back to it", async () => {
    await boot();
    const projectId = c.q.projects()[0]!.id;
    c.agents.createAgent({ name: "Triage", prompt: "Triage feedback", enabled: true, projectId, triggers: [{ kind: "slack", events: ["mention"], channelIds: ["C1"], emoji: [] }] });
    const contexts: string[] = [];
    runtime.forAgent("Triage", async (ctx) => {
      contexts.push(ctx.message.text);
      expect(ctx.options.tools.map((t) => t.name)).toContain("slack_reply");
      await ctx.call("slack_reply", { channel: "C1", thread_ts: "1700000000.000100", text: "On it." });
      return "Replied";
    });

    // Slack sends a mention as both app_mention and message; Cadence acts once.
    slack.emit({ type: "app_mention", channel: "C1", user: "U1", ts: "1700000000.000100", text: "<@UBOT> checkout is broken on Safari" });
    slack.emit({ type: "message", channel: "C1", user: "U1", ts: "1700000000.000100", text: "<@UBOT> checkout is broken on Safari" });
    // Other channels, the bot's own posts, and edits are ignored.
    slack.emit({ type: "app_mention", channel: "C2", user: "U1", ts: "1700000000.000200", text: "<@UBOT> elsewhere" });
    slack.emit({ type: "message", channel: "C1", user: "UBOT", ts: "1700000000.000300", text: "my own post" });
    slack.emit({ type: "message", subtype: "message_changed", channel: "C1", ts: "1700000000.000400", text: "edit" });

    await until(() => c.q.runs().length === 1 && c.q.runs()[0]!.status === "succeeded", 20_000);
    expect(slack.acks).toHaveLength(5);
    const first = c.q.runs()[0]!;
    expect(first).toMatchObject({ trigger: "slack", threadKey: "slack:C1:1700000000.000100", issueId: null });
    expect(contexts[0]).toContain("Slack mention from Dana in <#C1>");
    expect(contexts[0]).toContain("> @Cadence checkout is broken on Safari");
    expect(slack.posts).toEqual([{ channel: "C1", text: "On it.", thread_ts: "1700000000.000100" }]);
    const chat = c.q.chat(first.chatId!)!;
    expect(chat.threadKey).toBe("slack:C1:1700000000.000100");
    expect(c.q.workspace(chat.workspaceId)!.branch).toMatch(/^cadence\/triage-/);

    // A plain reply in that thread (no mention, no message trigger) still reaches the same chat.
    slack.emit({ type: "message", channel: "C1", user: "U2", ts: "1700000000.000500", thread_ts: "1700000000.000100", text: "also on iOS" });
    await until(() => c.q.runs().length === 2 && c.q.runs().every((r) => r.status === "succeeded"), 10_000);
    const second = c.q.runs().find((r) => r.id !== first.id)!;
    expect(second.chatId).toBe(first.chatId);
    expect(contexts[1]).toContain("(thread reply)");
    expect(contexts[1]).toContain("also on iOS");
  });

  it("filters reactions by emoji and reconnects when Slack rotates the connection", async () => {
    await boot();
    c.agents.createAgent({ name: "Bugbot", prompt: "File bugs", enabled: true, triggers: [{ kind: "slack", events: ["reaction"], channelIds: [], emoji: ["bug"] }] });
    runtime.forAgent("Bugbot", async (ctx) => {
      await ctx.call("slack_react", { channel: "C9", ts: "1700000000.000700", emoji: ":eyes:" });
      return "ok";
    });
    slack.emit({ type: "reaction_added", user: "U1", reaction: "tada", item: { type: "message", channel: "C9", ts: "1700000000.000700" } });
    slack.emit({ type: "reaction_added", user: "U1", reaction: "bug", item: { type: "message", channel: "C9", ts: "1700000000.000700" } });
    await until(() => c.q.runs().length === 1 && c.q.runs()[0]!.status === "succeeded", 20_000);
    expect(c.q.runs()[0]!.context).toContain("reacted :bug:");
    expect(slack.reactions).toEqual([{ channel: "C9", timestamp: "1700000000.000700", name: "eyes" }]);

    for (const ws of slack.sockets) ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    await until(() => slack.opens >= 3 && c.slack.status().connection === "connected");
  });

  it("hides Slack tools until Slack is connected", async () => {
    await boot();
    c.slack.disconnect();
    const ws = await c.workspaces.createInProject(c.q.projects()[0]!.id, "x", "user");
    const chat = c.engine.createChat({ workspaceId: ws.id });
    await c.engine.send(chat.id, { text: "hi" });
    await until(() => runtime.sessions.length === 1);
    expect(runtime.sessions[0]!.options.tools.some((t) => t.name.startsWith("slack_"))).toBe(false);
  });
});
