import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { designToolPrompt } from "../src/canvas/design-tools";
import type { FakeRuntime } from "./helpers/fake-runtime";
import { until } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";

describe("design actions and tokens over the API", () => {
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    fx?.cleanup();
    fx = null;
  });

  it("starts design system jobs as workspace chats and edits tokens", async () => {
    fx = createGitFixture({ "README.md": "# shop\n", "src/index.css": "@theme {\n  --color-brand: #2563eb;\n}\n" });
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "shop", path: fx.repo, baseBranch: "main", githubRepo: null });
    const ws = await team.c.workspaces.createInProject(project.id, "Design", "system");
    (team.c.runtime as FakeRuntime).next(async () => "done");
    const r = await team.local("POST", `/workspaces/${ws.id}/canvas/design-tool`, { tool: "harden", note: "Buttons first" });
    expect(r.status).toBe(201);
    expect(team.c.q.chat(r.json.chatId)).toMatchObject({ title: "Tighten components", workspaceId: ws.id, mode: "default" });
    await until(() => team.c.q.chatItems(r.json.chatId).some((i) => i.kind === "user"));
    const sent = team.c.q.chatItems(r.json.chatId).find((i) => i.kind === "user")!;
    expect(sent.kind === "user" && sent.text).toContain("wait for my approval");
    expect(sent.kind === "user" && sent.text).toContain("Notes: Buttons first");
    expect((await team.local("POST", `/workspaces/${ws.id}/canvas/design-tool`, { tool: "paint" })).status).toBe(400);

    const tokens = await team.local("GET", `/workspaces/${ws.id}/canvas/tokens`);
    expect(tokens.json).toEqual([expect.objectContaining({ name: "--color-brand", scope: "@theme", file: "src/index.css" })]);
    const saved = await team.local("PUT", `/workspaces/${ws.id}/canvas/tokens`, { file: "src/index.css", name: "--color-brand", scope: "@theme", value: "#7c3aed" });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(ws.path, "src/index.css"), "utf8")).toContain("--color-brand: #7c3aed;");
    expect((await team.local("PUT", `/workspaces/${ws.id}/canvas/tokens`, { file: "../../etc.css", name: "--x", value: "1px", add: true })).status).toBe(400);
  });

  it("writes each prompt in full", () => {
    expect(designToolPrompt("audit", "")).toContain("Do not fix the code.");
    expect(designToolPrompt("review", "")).toContain("canvas_screenshot");
    expect(designToolPrompt("generate", "")).not.toContain("Notes:");
  });
});
