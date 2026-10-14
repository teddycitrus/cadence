import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { reviewTools } from "../src/agents/review-tools";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import type { FakeRuntime } from "./helpers/fake-runtime";
import { until } from "./helpers/fake-runtime";
import { bootTeam } from "./helpers/team";
import { removeTempDir } from "./helpers/temp-dir";

describe("dates, findings, restarts, and imports", () => {
  const dirs: string[] = [];
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    fx?.cleanup();
    fx = null;
    for (const d of dirs.splice(0)) removeTempDir(d);
  });

  it("gives issues start and due dates, and checks them", async () => {
    const team = await bootTeam();
    close = team.close;
    const issue = team.c.issues.createIssue({ title: "Launch", body: "", type: "feature", priority: "high" }, "user");
    expect((await team.local("PATCH", `/issues/${issue.id}`, { startDate: "2026-10-01", dueDate: "2026-10-14" })).json).toMatchObject({ startDate: "2026-10-01", dueDate: "2026-10-14" });
    expect((await team.local("PATCH", `/issues/${issue.id}`, { startDate: "2026-10-20", dueDate: "2026-10-01" })).status).toBe(400);
    expect((await team.local("PATCH", `/issues/${issue.id}`, { dueDate: "14/10/2026" })).status).toBe(400);
    expect((await team.local("PATCH", `/issues/${issue.id}`, { dueDate: null })).json.dueDate).toBeNull();
  });

  it("reports review findings worst first", async () => {
    const [tool] = reviewTools();
    const ctx = { actor: "agent:x" as const, runId: null, issueId: null, workspaceId: null, ownerId: null };
    const out = await tool!.run({ findings: [{ file: "a.ts", severity: "low", summary: "nit" }, { file: "b.ts", line: 4, severity: "high", summary: "crash", failureScenario: "null input" }] }, ctx as never);
    expect(String(out)).toBe("Reported 2 findings (1 high, 0 medium, 1 low).");
    expect(String(await tool!.run({ findings: [] }, ctx as never))).toBe("Reported: no findings.");
  });

  it("marks chats a restart cut off, with a notice", async () => {
    const team = await bootTeam();
    close = team.close;
    const ws = await team.c.workspaces.createInProject(null, "Busy", "user");
    const chat = team.c.engine.createChat({ workspaceId: ws.id });
    team.c.store.append({ aggregate: "chat", type: "ChatStatusChanged", aggregateId: chat.id, payload: { status: "running" } }, "system");
    team.c.engine.recover();
    expect(team.c.q.chat(chat.id)).toMatchObject({ status: "interrupted", stoppedByRestart: true });
    expect(team.c.q.chatItems(chat.id).at(-1)).toMatchObject({ kind: "notice", tone: "warn" });
    // Its next status change clears the mark.
    (team.c.runtime as FakeRuntime).next(async () => "ok");
    await team.c.engine.send(chat.id, { text: "Continue where you left off." });
    await until(() => team.c.q.chat(chat.id)!.status === "idle");
    expect(team.c.q.chat(chat.id)!.stoppedByRestart).toBeUndefined();
  });

  it("clones into a chosen folder, and starts first tasks with edits", async () => {
    fx = createGitFixture();
    const team = await bootTeam();
    close = team.close;

    const parent = mkdtempSync(join(tmpdir(), "cadence-parent-"));
    dirs.push(parent);
    expect((await team.local("POST", "/start/import", { url: pathToFileURL(fx.repo).href, parent: "relative/path" })).status).toBe(400);
    const imported = await team.local("POST", "/start/import", { url: pathToFileURL(fx.repo).href, parent });
    expect(imported.status).toBe(201);
    expect(imported.json.path.toLowerCase().startsWith(parent.toLowerCase())).toBe(true);

    const prompt = (await team.local("GET", "/start/tasks/check-ci/prompt")).json.prompt as string;
    expect(prompt).toContain("CI");
    (team.c.runtime as FakeRuntime).next(async () => "done");
    const started = await team.local("POST", "/start/tasks", { task: "check-ci", projectId: imported.json.id, prompt: "Only look at the unit tests.", model: "claude-sonnet-5-5", effort: "low" });
    expect(started.status).toBe(201);
    expect(team.c.q.chat(started.json.chatId)).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
    await until(() => team.c.q.chatItems(started.json.chatId).some((i) => i.kind === "user"));
    const sent = team.c.q.chatItems(started.json.chatId).find((i) => i.kind === "user")!;
    expect(sent.kind === "user" && sent.text).toBe("Only look at the unit tests.");
  });
});
