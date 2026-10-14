import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { makeContainer, offlineLlm } from "./helpers/setup";
import { modelFor, pickMode, toolInput, toolName } from "../src/agents/acp/mapping";

const AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

describe("ACP mapping", () => {
  // Codex's modes as its ACP adapter reports them.
  const codexModes = [
    { id: "read-only", name: "Read-only" },
    { id: "workspace-write", name: "Workspace access" },
    { id: "agent", name: "Auto review" },
    { id: "agent-full-access", name: "Full access" },
  ];

  it("maps chat modes onto a harness's own modes", () => {
    expect(pickMode("default", codexModes)?.id).toBe("read-only");
    expect(pickMode("acceptEdits", codexModes)?.id).toBe("workspace-write");
    expect(pickMode("plan", codexModes)?.id).toBe("read-only");
    expect(pickMode("bypassPermissions", codexModes)?.id).toBe("agent-full-access");
    const claudeLike = ["default", "acceptEdits", "plan", "bypassPermissions"].map((id) => ({ id, name: id }));
    expect(pickMode("plan", claudeLike)?.id).toBe("plan");
    expect(pickMode("plan", [{ id: "chat", name: "Chat" }])).toBeNull();
  });

  it("puts the chat's effort into models that carry a level", () => {
    const models = ["gpt-6-luna[low]", "gpt-6-luna[high]", "gpt-5.6-terra[high]", "plain"];
    expect(modelFor("default", "low", "gpt-6-luna[high]", models)).toBe("gpt-6-luna[low]");
    expect(modelFor("gpt-5.6-terra", "high", "gpt-6-luna[high]", models)).toBe("gpt-5.6-terra[high]");
    expect(modelFor("gpt-6-luna[low]", "high", null, models)).toBe("gpt-6-luna[low]");
    expect(modelFor("plain", "high", null, models)).toBe("plain");
    expect(modelFor("default", "high", "plain", models)).toBeNull();
    expect(modelFor("missing", "high", null, models)).toBeNull();
  });

  it("names MCP calls reported as commands after their server and tool", () => {
    const call = { toolCallId: "x", kind: "execute", title: "mcp.cadence.issues_list", rawInput: { server: "cadence", tool: "issues_list", arguments: { stage: "Ideas" } } };
    expect(toolName(call)).toBe("mcp__cadence__issues_list");
    expect(toolInput(call)).toEqual({ stage: "Ideas" });
    expect(toolName({ kind: "execute", title: "npm test" })).toBe("Bash");
  });
});

describe("ACP harnesses", () => {
  let fx: GitFixture;
  let c: Container;
  let server: Server;

  const boot = async (env: Record<string, string> = {}, command = `"${process.execPath}" "${AGENT}"`) => {
    fx = createGitFixture();
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm, idleMs: 60_000 });
    server = createApp(c, { apiToken: null, staticDir: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    c.toolBridge.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    c.providers.update("codex", { command, env });
    c.start();
  };

  afterEach(() => {
    c.stop();
    server.close();
    c.db.close();
    fx.cleanup();
  });

  const chatOn = async (mode: "default" | "acceptEdits" | "plan" | "bypassPermissions" = "default") => {
    const ws = await c.workspaces.createInProject(null, "Harness", "user");
    return { ws, chat: c.engine.createChat({ workspaceId: ws.id, provider: "codex", mode }) };
  };
  const settled = (chatId: string) => until(() => ["idle", "error", "interrupted"].includes(c.q.chat(chatId)!.status), 15_000);
  const texts = (chatId: string) => c.q.chatItems(chatId).flatMap((i) => (i.kind === "assistant" ? [i.text] : []));

  it("runs a turn, sends the instructions once, applies mode and model, and resumes the session", async () => {
    await boot();
    const { ws, chat } = await chatOn();
    expect(chat).toMatchObject({ provider: "codex", model: "default" });
    await c.engine.send(chat.id, { text: "hello" });
    await settled(chat.id);
    expect(texts(chat.id)).toEqual(["You said: hello"]);
    const after = c.q.chat(chat.id)!;
    expect(after.sessionId).toMatch(/^s\d+/);
    expect(after.slashCommands).toEqual(["review"]);
    expect(after.commandHints).toEqual({ review: "Review" });
    expect(c.q.chatItems(chat.id).find((i) => i.kind === "turn")).toMatchObject({ inputTokens: 10, outputTokens: 5, isError: false });
    expect(readFileSync(join(ws.path, ".fake-acp-mode"), "utf8")).toBe("ask");
    expect(c.providers.status("codex").models).toEqual(["default", "fake-1", "fake-2"]);

    await c.engine.setModel(chat.id, "fake-2");
    await until(() => existsSync(join(ws.path, ".fake-acp-model")));
    await c.engine.setMode(chat.id, "bypassPermissions");
    await until(() => readFileSync(join(ws.path, ".fake-acp-mode"), "utf8") === "full-access");

    // A new process reloads the session; replayed history does not repeat in the transcript.
    c.engine.close(chat.id);
    await c.engine.send(chat.id, { text: "again" });
    await settled(chat.id);
    expect(texts(chat.id)).toEqual(["You said: hello", "You said: again"]);
    expect(c.q.chat(chat.id)!.sessionId).toBe(after.sessionId);
    const history = JSON.parse(readFileSync(join(ws.path, ".fake-acp", `${after.sessionId}.json`), "utf8")) as { role: string; text: string }[];
    const prompts = history.filter((h) => h.role === "user").map((h) => h.text);
    expect(prompts[0]).toContain("<cadence_instructions>");
    expect(prompts[1]).toBe("again");
  });

  it("asks before edits in ask mode, then writes through the client", async () => {
    await boot();
    const { ws, chat } = await chatOn("default");
    await c.engine.send(chat.id, { text: "edit" });
    await until(() => c.q.pendingInteractions().length === 1, 15_000);
    const pending = c.q.pendingInteractions()[0]!;
    expect(pending).toMatchObject({ kind: "tool", toolName: "Edit" });
    expect(pending.input).toMatchObject({ file_path: "notes.txt" });
    await c.engine.resolve(pending.id, { kind: "tool", allow: true, always: true });
    await settled(chat.id);
    expect(readFileSync(join(ws.path, "notes.txt"), "utf8")).toBe("hello");
    const result = c.q.chatItems(chat.id).find((i) => i.kind === "tool_result");
    expect(result).toMatchObject({ content: "wrote (always)", isError: false });
  });

  it("lets edits through in accept-edits mode and refuses them in plan mode", async () => {
    await boot();
    const { ws, chat } = await chatOn("acceptEdits");
    await c.engine.send(chat.id, { text: "edit" });
    await settled(chat.id);
    expect(readFileSync(join(ws.path, "notes.txt"), "utf8")).toBe("hello");
    expect(c.q.pendingInteractions()).toHaveLength(0);

    const planned = c.engine.createChat({ workspaceId: ws.id, provider: "codex", mode: "plan" });
    await c.engine.send(planned.id, { text: "edit" });
    await settled(planned.id);
    expect(texts(planned.id)).toEqual(["Not allowed."]);
  });

  it("gives the harness the session's board tools over HTTP and over the stdio proxy", async () => {
    await boot();
    c.issues.createIssue({ title: "Fix the login bug" });
    const { chat } = await chatOn();
    await c.engine.send(chat.id, { text: "board" });
    await settled(chat.id);
    expect(texts(chat.id)[0]).toContain("Fix the login bug");
    expect(c.q.chatItems(chat.id).some((i) => i.kind === "todo")).toBe(true);
    expect(c.toolBridge.size).toBe(1);
    c.engine.close(chat.id);
    await until(() => c.toolBridge.size === 0);

    c.providers.update("codex", { env: { FAKE_ACP_NO_HTTP: "1" } });
    const other = c.engine.createChat({ workspaceId: chat.workspaceId, provider: "codex" });
    await c.engine.send(other.id, { text: "board" });
    await settled(other.id);
    expect(texts(other.id)[0]).toMatch(/^Board says: \(stdio\) .*Fix the login bug/s);
  });

  it("stops a turn on interrupt and reports a missing harness plainly", async () => {
    await boot();
    const { chat } = await chatOn();
    let streamed = "";
    c.bus.subscribe((e) => {
      if (e.type === "delta" && e.chatId === chat.id) streamed += e.text;
    });
    await c.engine.send(chat.id, { text: "wait" });
    await until(() => streamed === "Working", 15_000);
    await c.engine.interrupt(chat.id);
    await settled(chat.id);
    expect(c.q.chat(chat.id)!.status).toBe("interrupted");

    c.providers.update("codex", { command: "definitely-not-a-real-harness-xyz acp" });
    const broken = c.engine.createChat({ workspaceId: chat.workspaceId, provider: "codex" });
    await c.engine.send(broken.id, { text: "hello" });
    await settled(broken.id);
    const errors = c.q.chatItems(broken.id).filter((i) => (i.kind === "turn" && i.isError) || (i.kind === "notice" && i.tone === "error"));
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toMatch(/not installed or its command is wrong|stopped/);
  });

  it("asks for a sign-in when the harness needs one, and uses a saved key", async () => {
    await boot({ FAKE_ACP_AUTH: "1" });
    const { chat } = await chatOn();
    await c.engine.send(chat.id, { text: "hello" });
    await settled(chat.id);
    expect(JSON.stringify(c.q.chatItems(chat.id))).toContain("needs you to sign in");

    c.providers.update("codex", { env: { FAKE_ACP_KEY: "sk-test" } });
    const signedIn = c.engine.createChat({ workspaceId: chat.workspaceId, provider: "codex" });
    await c.engine.send(signedIn.id, { text: "hello" });
    await settled(signedIn.id);
    expect(texts(signedIn.id)).toEqual(["You said: hello"]);
    expect(c.providers.status("codex").envSet).toEqual(["FAKE_ACP_AUTH", "FAKE_ACP_KEY"]);
    expect(JSON.stringify(c.providers.all())).not.toContain("sk-test");
  });

  it("supports CLI mode: creates a session to resume and reads its history back", async () => {
    await boot();
    const { ws, chat } = await chatOn();
    const cli = c.runtimes.get("codex").cli!;
    const fresh = await cli.ensureSession!(ws.path);
    expect(cli.command({ sessionId: fresh, resume: true, model: "default", mode: "default" })).toBe(`codex resume ${fresh}`);
    expect(await cli.transcript(fresh, ws.path)).toEqual([]);

    await c.engine.send(chat.id, { text: "hello" });
    await settled(chat.id);
    const sessionId = c.q.chat(chat.id)!.sessionId!;
    const first = await cli.transcript(sessionId, ws.path);
    expect(first.map((m) => m.items.map((i) => i.kind))).toEqual([["user"], ["assistant"]]);
    expect(first[1]!.items[0]).toMatchObject({ kind: "assistant", text: "You said: hello" });
    // Same history, same ids: CLI mode tells new messages from ones it already has.
    expect((await cli.transcript(sessionId, ws.path)).map((m) => m.id)).toEqual(first.map((m) => m.id));
    expect(readdirSync(join(ws.path, ".fake-acp"))).toContain(`${sessionId}.json`);
  });
});

describe("keys per model", () => {
  it("layers a model's own key over the harness-wide one, only for that model", () => {
    const { c } = makeContainer();
    c.providers.update("codex", { env: { OPENAI_API_KEY: "sk-shared" } });
    c.providers.update("codex", { modelEnv: { "gpt-6-astra": { OPENAI_API_KEY: "sk-astra" } } });
    expect(c.providers.env("codex", "gpt-6-astra").OPENAI_API_KEY).toBe("sk-astra");
    expect(c.providers.env("codex", "gpt-5.5").OPENAI_API_KEY).toBe("sk-shared");
    expect(c.providers.env("codex").OPENAI_API_KEY).toBe("sk-shared");
    // Status lists names only, never values.
    expect(c.providers.status("codex").modelEnvSet).toEqual({ "gpt-6-astra": ["OPENAI_API_KEY"] });
    expect(JSON.stringify(c.providers.status("codex"))).not.toContain("sk-astra");
    c.providers.update("codex", { modelEnv: { "gpt-6-astra": { OPENAI_API_KEY: null } } });
    expect(c.providers.status("codex").modelEnvSet).toEqual({});
  });
});
