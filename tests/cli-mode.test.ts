import { afterEach, describe, expect, it } from "vitest";
import { toItems } from "../src/agents/claude-cli";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { offlineLlm } from "./helpers/setup";

describe("CLI mode", () => {
  let fx: GitFixture | null = null;
  let c: Container;
  let runtime: FakeRuntime;

  afterEach(async () => {
    if (!fx) return;
    c.stop();
    c.db.close();
    await c.terminals.exited();
    fx.cleanup();
    fx = null;
  });

  const boot = async () => {
    fx = createGitFixture();
    runtime = new FakeRuntime();
    c = createContainer({ dataDir: fx.dataDir, dbFile: ":memory:", runtime, llm: offlineLlm });
    c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null });
    const ws = await c.workspaces.createInProject(c.q.projects()[0]!.id, "cli", "user");
    return c.engine.createChat({ workspaceId: ws.id });
  };

  it("hands the chat to the CLI, locks the GUI, and imports the CLI's turns on the way back", async () => {
    const chat = await boot();
    const status = await c.cliMode.enter(chat.id);
    expect(status).toMatchObject({ active: true, available: true });

    // The CLI runs in a real terminal in the workspace.
    let out = "";
    c.terminals.attach(status.terminalId!, (m) => {
      if (m.type === "output") out += m.data;
    });
    // Wait for the whole id: output arrives in chunks.
    await until(() => /fake-cli new [0-9a-f-]{36}/.test(out), 15_000);
    const sessionId = /fake-cli new ([0-9a-f-]{36})/.exec(out)![1]!;

    // Meanwhile the GUI cannot send into the same session.
    await expect(c.engine.send(chat.id, { text: "hi" })).rejects.toThrow(/open in the CLI/);

    runtime.cliTranscripts.set(sessionId, [
      { id: "m1", items: [{ kind: "user", text: "rename add to sum", attachments: [], author: "user", steer: false }] },
      { id: "m2", items: [{ kind: "assistant", text: "Renamed it." }] },
    ]);
    expect(await c.cliMode.exit(chat.id)).toEqual({ imported: 2 });
    expect(c.terminals.list()).toEqual([]);

    const items = c.q.chatItems(chat.id).map((i) => (i.kind === "notice" || i.kind === "assistant" || i.kind === "user" ? `${i.kind}:${i.text}` : i.kind));
    expect(items).toEqual(["notice:Continued in the CLI", "user:rename add to sum", "assistant:Renamed it."]);
    // The GUI resumes the same session the CLI used.
    expect(c.q.chat(chat.id)!.sessionId).toBe(sessionId);
    await expect(c.engine.send(chat.id, { text: "and now from the GUI" })).resolves.toEqual({ queued: false });
  });

  it("resumes an existing session and imports only what is new", async () => {
    const chat = await boot();
    c.engine.importItems(chat.id, [], "11111111-2222-3333-4444-555555555555");
    runtime.cliTranscripts.set("11111111-2222-3333-4444-555555555555", [{ id: "old", items: [{ kind: "assistant", text: "earlier" }] }]);
    const status = await c.cliMode.enter(chat.id);
    let out = "";
    c.terminals.attach(status.terminalId!, (m) => {
      if (m.type === "output") out += m.data;
    });
    await until(() => out.includes("fake-cli resume 11111111"), 15_000);
    runtime.cliTranscripts.get("11111111-2222-3333-4444-555555555555")!.push({ id: "new", items: [{ kind: "assistant", text: "later" }] });
    expect(await c.cliMode.exit(chat.id)).toEqual({ imported: 1 });
    expect(c.q.chatItems(chat.id).filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text)).toEqual(["later"]);
  });

  it("converts Claude Code transcript messages, skipping CLI bookkeeping", () => {
    expect(toItems({ type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } })).toEqual([]);
    expect(toItems({ type: "user", message: { role: "user", content: [{ type: "text", text: "fix it" }] } })).toEqual([{ kind: "user", text: "fix it", attachments: [], author: "user", steer: false }]);
    expect(
      toItems({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "On it." }, { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.js" } }] },
      }),
    ).toEqual([
      { kind: "assistant", text: "On it." },
      { kind: "tool_use", toolUseId: "t1", name: "Edit", input: { file_path: "a.js" } },
    ]);
    expect(toItems({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] } })).toEqual([
      { kind: "tool_result", toolUseId: "t1", content: "ok", isError: false },
    ]);
  });
});
