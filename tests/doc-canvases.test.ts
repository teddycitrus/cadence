import { afterEach, describe, expect, it } from "vitest";
import { canvasEmbedBlock, canvasEmbeds, parseCanvasEmbed } from "../src/docs/canvas-embed";
import type { FakeRuntime } from "./helpers/fake-runtime";
import { until } from "./helpers/fake-runtime";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";

describe("canvas embeds in docs", () => {
  it("parses, formats, and finds embeds in markdown, refusing bad references", () => {
    const e = { workspaceId: "ws-1", path: "src/checkout.canvas.tsx", story: "Empty" };
    expect(canvasEmbedBlock(e)).toBe("```canvas\nworkspace: ws-1\npath: src/checkout.canvas.tsx\nstory: Empty\n```");
    expect(parseCanvasEmbed("workspace: ws-1\npath: src/checkout.canvas.tsx")).toEqual({ ...e, story: null });
    expect(parseCanvasEmbed("workspace: ws-1\npath: ../secret.canvas.tsx")).toBeNull();
    expect(parseCanvasEmbed("workspace: ws-1\npath: notes.md")).toBeNull();
    expect(parseCanvasEmbed("workspace: ws 1\npath: a.canvas.tsx")).toBeNull();
    expect(parseCanvasEmbed("workspace: ws-1\npath: a.canvas.tsx\nstory: not valid")).toBeNull();
    const md = `# Checkout\n\nIntro.\n\n${canvasEmbedBlock(e)}\n\nMore.\n\n\`\`\`canvas\nworkspace: ws-2\npath: cards.canvas.ts\n\`\`\`\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`;
    expect(canvasEmbeds(md)).toEqual([e, { workspaceId: "ws-2", path: "cards.canvas.ts", story: null }]);
  });
});

describe("generate canvases from a doc", () => {
  let fx: GitFixture;
  let close = () => {};
  afterEach(() => {
    close();
    fx.cleanup();
  });

  it("starts an agent in a new workspace with the doc and workspace in its task, and keeps members out", async () => {
    fx = createGitFixture();
    const team = await bootTeam();
    close = team.close;
    const { c, local } = team;
    const runtime = c.runtime as FakeRuntime;
    runtime.next(async () => "done");
    const project = c.agents.addProject({ name: "shop", path: fx.repo, baseBranch: "main", githubRepo: null });
    const doc = c.docs.create({ title: "Checkout", body: "## Cart\nEmpty and full states.", issueId: null, parentId: null }, "user");

    const r = await local("POST", `/docs/${doc.id}/generate-canvases`, { projectId: project.id, note: "Mobile first" });
    expect(r.status).toBe(201);
    const ws = c.q.workspace(r.json.workspaceId)!;
    expect(ws).toMatchObject({ projectId: project.id, name: "Canvases: Checkout" });
    await until(() => c.q.chatItems(r.json.chatId).some((i) => i.kind === "user"));
    const task = c.q.chatItems(r.json.chatId).find((i) => i.kind === "user")!;
    expect(task.kind === "user" && task.text).toContain(`doc id ${doc.id}`);
    expect(task.kind === "user" && task.text).toContain(`workspace: ${ws.id}`);
    expect(task.kind === "user" && task.text).toContain("Notes from the person who asked: Mobile first");

    const member = await team.join("member", "Mo");
    expect((await member.call("POST", `/docs/${doc.id}/generate-canvases`, { projectId: project.id })).status).toBe(403);
  });
});
