import { describe, expect, it } from "vitest";
import { callBoardTool, type ToolContext } from "../src/agents/board-tools";
import { issueTools } from "../src/agents/issue-tools";
import { docTools } from "../src/agents/doc-tools";
import { moreAgentTools } from "../src/agents/agent-tools-more";
import { commentTools } from "../src/canvas/comment-tools";
import { commentInbox, mentions } from "../src/canvas/inbox";
import { documentText } from "../src/integrations/documents";
import { SlackApi } from "../src/integrations/slack/api";
import type { SlackService } from "../src/integrations/slack/service";
import { moreSlackTools } from "../src/integrations/slack/tools-more";
import { orderIssues } from "../src/core/issue-views";
import { makeContainer } from "./helpers/setup";

const me: ToolContext = { actor: "user", runId: null, issueId: null, ownerId: "me" };

/** A one-page PDF whose page says `text`, with a correct cross-reference table. */
function tinyPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 60 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("the wider agent tool surface", () => {
  it("orders the board by hand and reorders between neighbors", async () => {
    const { c } = makeContainer();
    const tools = issueTools({ q: c.q, issues: c.issues, store: c.store, shares: c.shares, assets: c.assets });
    const [a, b, d] = ["First", "Second", "Third"].map((title) => c.issues.createIssue({ title, body: "", type: "bug", priority: "medium" }, "user"));
    // Newest first until someone places an issue.
    expect(orderIssues(c.q.issues(), "manual").map((i) => i.title).slice(0, 3)).toEqual(["Third", "Second", "First"]);
    await callBoardTool(tools, "issues_reorder", { issue: a!.key, above: d!.key, below: b!.key }, me);
    expect(orderIssues(c.q.issues(), "manual").map((i) => i.title).slice(0, 3)).toEqual(["Third", "First", "Second"]);
    await callBoardTool(tools, "issues_reorder", { issue: d!.key, above: b!.key }, me);
    expect(orderIssues(c.q.issues(), "manual").map((i) => i.title).slice(0, 3)).toEqual(["First", "Second", "Third"]);
    expect((await callBoardTool(tools, "issues_reorder", { issue: a!.key, above: a!.key }, me)).isError).toBe(true);
  });

  it("searches, bulk edits, deletes with confirmation, and reports on the board", async () => {
    const { c } = makeContainer();
    const tools = issueTools({ q: c.q, issues: c.issues, store: c.store, shares: c.shares, assets: c.assets });
    const crash = c.issues.createIssue({ title: "Crash on save", body: "Stack trace inside", type: "bug", priority: "high" }, "user");
    const idea = c.issues.createIssue({ title: "Dark mode", body: "", type: "feature", priority: "low" }, "user");
    expect((await callBoardTool(tools, "issues_search", { query: "stack" }, me)).text).toContain(crash.key);
    expect((await callBoardTool(tools, "issues_search", { types: ["feature"] }, me)).text).not.toContain(crash.key);

    const bulk = await callBoardTool(tools, "issues_bulk_update", { issues: [crash.key, idea.key], priority: "urgent", add_label: "Needs a product call", add_assignee: "me" }, me);
    expect(bulk.text).toContain("Updated 2");
    expect(c.q.issue(crash.id)!.priority).toBe("urgent");
    expect((await callBoardTool(tools, "issues_find_my_work", {}, me)).text.split("\n")).toHaveLength(2);

    const stages = c.q.stages();
    await callBoardTool(tools, "issues_bulk_update", { issues: [idea.key], stage: stages[1]!.name }, me);
    const report = await callBoardTool(tools, "issues_lifecycle_report", { since: "2000-01-01", to_stage: stages[1]!.name }, me);
    expect(report.text).toContain(idea.key);
    expect((await callBoardTool(tools, "issues_suggest_stage", { issue: crash.key }, me)).text).toMatch(/Next: /);
    expect((await callBoardTool(tools, "issues_activity", { issue: crash.key }, me)).text).toMatch(/created in .*\n.*changed priority/);
    expect((await callBoardTool(tools, "issues_board_summary", {}, me)).text).toContain("2 issues.");

    expect((await callBoardTool(tools, "issues_delete", { issue: idea.key }, me)).isError).toBe(true);
    await callBoardTool(tools, "issues_delete", { issue: idea.key, confirm: true }, me);
    expect(c.q.issue(idea.id)).toBeNull();

    const share = await callBoardTool(tools, "issues_share_link", { issue: crash.key, public: true }, me);
    expect(share.text).toMatch(/#\/share\/[\w-]{20,}$/);
    const img = await callBoardTool(tools, "issues_upload_image", { data: Buffer.from("\x89PNG\r\n\x1a\nfake").toString("base64"), name: "shot.png" }, me);
    expect(img.text).toMatch(/^!\[shot\.png\]\(\/api\/assets\/[0-9a-f-]{36}\)$/);
    expect((await callBoardTool(tools, "issues_upload_image", { path: "C:/Windows/win.ini" }, { ...me, actor: "token:t1" })).isError).toBe(true);

    await callBoardTool(tools, "views_save", { name: "Bugs", types: ["bug"], layout: "list" }, me);
    expect((await callBoardTool(tools, "views_list", {}, me)).text).toContain("Bugs");
  });

  it("finds docs by title and body, walks the tree, and restores versions", async () => {
    const { c } = makeContainer();
    const tools = docTools(c.q, c.docs, c.shares);
    const parent = c.docs.create({ title: "Checkout PRD", body: "## Goals\nFaster checkout" }, "user");
    const child = c.docs.create({ title: "Payment errors", body: "Card declined\nRetry flow", parentId: parent.id }, "user");
    expect((await callBoardTool(tools, "docs_search", { query: "checkout" }, me)).text).toContain(parent.id);
    expect((await callBoardTool(tools, "docs_grep", { pattern: "declined" }, me)).text).toContain("> 1: Card declined");
    expect((await callBoardTool(tools, "docs_tree", {}, me)).text).toMatch(/Checkout PRD.*1 sub-pages[\s\S]*  - Payment errors/);
    expect((await callBoardTool(tools, "docs_path", { doc: child.id }, me)).text).toBe(`Checkout PRD (id ${parent.id}) / Payment errors (id ${child.id})`);
    c.docs.update(child.id, { body: "Rewritten" }, "user");
    await callBoardTool(tools, "docs_restore", { doc: child.id, version: 1 }, me);
    expect(c.q.doc(child.id)!.body).toBe("Card declined\nRetry flow");
    await callBoardTool(tools, "docs_move", { doc: child.id, parent: null }, me);
    expect(c.q.doc(child.id)!.parentId).toBeNull();
    await callBoardTool(tools, "docs_delete", { doc: parent.id, confirm: true }, me);
    expect(c.q.doc(parent.id)).toBeNull();
  });

  it("gives agents the assignable directory, run history, and trigger setup", async () => {
    const { c } = makeContainer();
    const tools = moreAgentTools(c.q, c.agents);
    const agent = c.agents.createAgent({ name: "Hooky", prompt: "Do it", triggers: [{ kind: "webhook", secret: "s3cret" }], enabled: true, ownerId: "me" }, "user");
    expect((await callBoardTool(tools, "agents_list_assignable", {}, me)).text).toContain('"Hooky"');
    expect((await callBoardTool(tools, "agents_trigger_setup", { agent: "Hooky" }, me)).text).toContain(`/api/hooks/agents/${agent.id}/s3cret`);
    expect((await callBoardTool(tools, "agents_template_get", { template: "bug-squasher" }, me)).text).toContain("Instructions:");
    // Someone else cannot see the webhook secret.
    expect((await callBoardTool(tools, "agents_trigger_setup", { agent: "Hooky" }, { ...me, ownerId: "other" })).isError).toBe(true);
    c.agents.queueRun({ agentId: agent.id, issueId: null, trigger: "manual", context: "" }, "user");
    expect((await callBoardTool(tools, "agents_list_runs", { agent: "Hooky" }, me)).text).toMatch(/queued \(manual\)/);
  });

  it("keeps a comment inbox of mentions and replies, and tools for threads", async () => {
    const { c } = makeContainer();
    const ws = await c.workspaces.createInProject(null, "Design", "user");
    c.store.append({ aggregate: "member", type: "MemberJoined", aggregateId: "ada", payload: { name: "Ada Lovelace", email: "ada@example.com", role: "member", color: "#fff" } }, "system");
    const tools = commentTools(c.canvases, c.q);
    const ctx = { ...me, workspaceId: ws.id };
    expect(mentions("thoughts @ada?", { name: "Ada Lovelace", email: "ada@example.com" })).toBe(true);
    expect(mentions("cc @adam", { name: "Ada", email: "" })).toBe(false);

    const started = await callBoardTool(tools, "comments_create_thread", { path: "src/a.canvas.tsx", x: 10, y: 20, body: "Can @Ada check the spacing?" }, ctx);
    const threadId = started.text.match(/thread (\S+)\./)![1]!;
    expect(commentInbox(c.q, "ada").map((i) => i.reason)).toEqual(["mention"]);
    expect(commentInbox(c.q, "me")).toEqual([]);

    c.canvases.comment(ws.id, { canvasPath: "src/a.canvas.tsx", storyId: null, x: 10, y: 20, parentId: threadId, body: "Looks tight to me", attachments: [] }, "member:ada");
    expect(commentInbox(c.q, "me").map((i) => i.reason)).toEqual(["reply"]);
    await callBoardTool(tools, "comments_mark_read", { thread_id: threadId }, ctx);
    expect(commentInbox(c.q, "me")).toEqual([]);

    await callBoardTool(tools, "comments_react", { comment_id: threadId, emoji: "eyes" }, ctx);
    expect(c.q.canvasComments(ws.id).find((x) => x.id === threadId)!.reactions?.eyes).toEqual(["user"]);
    expect((await callBoardTool(tools, "comments_search", { query: "tight" }, ctx)).text).toContain(threadId);
    await callBoardTool(tools, "comments_resolve", { thread_id: threadId }, ctx);
    expect((await callBoardTool(tools, "comments_threads", {}, ctx)).text).toBe("No threads.");
    expect((await callBoardTool(tools, "comments_edit", { comment_id: threadId, body: "x" }, { ...ctx, actor: "member:ada" })).isError).toBe(true);
  });

  it("reads PDFs page by page and drives the extra Slack calls", async () => {
    const pdf = await documentText("spec.pdf", "application/pdf", tinyPdf("Ship the checkout"));
    expect(pdf.text).toContain("Ship the checkout");
    expect(pdf.pages).toBe(1);
    expect((await documentText("notes.md", "text/markdown", Buffer.from("# Hi"))).text).toBe("# Hi");

    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://files.slack.com/")) return new Response(new Uint8Array(tinyPdf("Attached PRD")));
      const method = new URL(url).pathname.replace("/api/", "");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      const ok = (d: Record<string, unknown> = {}) => new Response(JSON.stringify({ ok: true, ...d }));
      if (method === "users.lookupByEmail") return ok({ user: { id: "U42", name: "dana", profile: { email: body.email } } });
      if (method === "conversations.open") return ok({ channel: { id: "D9" } });
      if (method === "chat.postMessage") return ok({ ts: "1.2", channel: body.channel });
      if (method === "files.info") return ok({ file: { id: "F1", name: "prd.pdf", mimetype: "application/pdf", size: 10, url_private_download: "https://files.slack.com/files-pri/T1-F1/prd.pdf" } });
      return ok();
    };
    const { c } = makeContainer();
    const slack = { api: () => new SlackApi("xoxb-test", fakeFetch) } as unknown as SlackService;
    const tools = moreSlackTools(slack, c.q, c.store);
    expect((await callBoardTool(tools, "slack_send_dm", { to: ["dana@example.com"], text: "Done" }, me)).text).toBe("Sent (channel D9, ts 1.2).");
    expect(calls.find((x) => x.method === "conversations.open")!.body.users).toBe("U42");
    expect((await callBoardTool(tools, "slack_read_file", { file: "F1" }, me)).text).toMatch(/# prd\.pdf \(1 pages\)[\s\S]*Attached PRD/);
    await callBoardTool(tools, "slack_unreact", { channel: "C1", ts: "1.2", emoji: ":eyes:" }, me);
    expect(calls.at(-1)).toEqual({ method: "reactions.remove", body: { channel: "C1", timestamp: "1.2", name: "eyes" } });
    expect((await callBoardTool(tools, "slack_subscribe_thread", { channel: "C1", thread_ts: "1.2" }, me)).isError).toBe(true);
  });
});

describe("tool gaps closed in the audit", () => {
  it("edits issue bodies by exact passage, guards doc writes by version, and searches templates", async () => {
    const { c } = makeContainer();
    const tools = issueTools({ q: c.q, issues: c.issues, store: c.store, shares: c.shares, assets: c.assets });
    const i = c.issues.createIssue({ title: "Spec", body: "Steps:\n1. open\n2. open again", type: "chore", priority: "low" }, "user");
    expect((await callBoardTool(tools, "issues_edit_body", { issue: i.key, old_text: "open", new_text: "close" }, me)).text).toMatch(/appears 2 times/);
    await callBoardTool(tools, "issues_edit_body", { issue: i.key, old_text: "2. open again", new_text: "2. ship" }, me);
    expect(c.q.issue(i.id)!.body).toBe("Steps:\n1. open\n2. ship");

    const { boardTools } = await import("../src/agents/board-tools");
    const board = boardTools({ q: c.q, issues: c.issues, docs: c.docs });
    const d = c.docs.create({ title: "Plan", body: "v1" }, "user");
    expect((await callBoardTool(board, "docs_get", { doc: d.id }, me)).text).toContain("(version 1)");
    c.docs.update(d.id, { body: "someone else" }, "user");
    expect((await callBoardTool(board, "docs_update", { doc: d.id, body: "mine", version: 1 }, me)).isError).toBe(true);
    expect((await callBoardTool(board, "docs_update", { doc: d.id, body: "mine", version: 2 }, me)).text).toBe("Doc updated to version 3.");

    const { agentTools } = await import("../src/agents/agent-tools");
    const found = (await callBoardTool(agentTools(c.q, c.agents), "agents_templates", { query: "bug" }, me)).text;
    expect(found).toContain("bug-squasher");
    expect(found).not.toContain("release");
  });

  it("reads one canvas comment thread in full", async () => {
    const { c } = makeContainer();
    const ws = await c.workspaces.createInProject(null, "D", "user");
    const root = c.canvases.comment(ws.id, { canvasPath: "a.canvas.tsx", storyId: "S", x: 1, y: 2, parentId: null, body: "Too tight", attachments: [{ url: "/api/assets/x", name: "shot.png" }] }, "user");
    c.canvases.react(ws.id, root.id, "eyes", true, "user");
    const text = (await callBoardTool(commentTools(c.canvases, c.q), "comments_get_thread", { thread_id: root.id }, me)).text;
    expect(text).toContain("a.canvas.tsx on S at (1, 2)");
    expect(text).toContain("attachments: shot.png /api/assets/x");
    expect(text).toContain("reactions: eyes 1");
  });

  it("renders a PDF page to an image and refuses unshared Google Docs", async () => {
    const { pdfPageImage, googleDocText } = await import("../src/integrations/documents");
    const { PNG } = await import("pngjs");
    const page = await pdfPageImage(tinyPdf("Scanned"), 1);
    expect(page.pages).toBe(1);
    const img = PNG.sync.read(page.png);
    // A 300pt-wide page renders at the 4x cap; large pages stop at 1600px.
    expect(Math.max(img.width, img.height)).toBe(1200);
    // Some pixel is dark: the text was drawn.
    let dark = false;
    for (let p = 0; p < img.data.length && !dark; p += 4) dark = img.data[p]! < 100;
    expect(dark).toBe(true);
    await expect(pdfPageImage(tinyPdf("x"), 2)).rejects.toThrow(/has 1 pages/);

    const shared: typeof fetch = async () => new Response("﻿Hello doc", { headers: { "content-type": "text/plain" } });
    expect((await googleDocText("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit", shared)).text).toBe("Hello doc");
    const signIn: typeof fetch = async () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } });
    await expect(googleDocText("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit", signIn)).rejects.toThrow(/not shared/);
    await expect(googleDocText("https://evil.example/document/d/x", shared)).rejects.toThrow(/Not a Google Docs link/);
  });
});
