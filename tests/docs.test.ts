import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boardTools, callBoardTool } from "../src/agents/board-tools";
import { DocConflictError } from "../src/docs/commands";
import { htmlToMarkdown, importFile } from "../src/docs/importer";
import { ValidationError } from "../src/core/errors";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

describe("docs", () => {
  let dir: string;
  let c: Container;
  const boot = () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-docs-"));
    c = createContainer({ dataDir: dir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
    return c;
  };
  afterEach(() => {
    if (!dir) return;
    c.db.close();
    removeTempDir(dir);
    dir = "";
  });

  it("builds a tree of pages with positions, moves them, and refuses cycles", () => {
    boot();
    const prd = c.docs.create({ title: "PRD" });
    const ux = c.docs.create({ title: "UX", parentId: prd.id });
    const api = c.docs.create({ title: "API", parentId: prd.id });
    expect([ux.position, api.position]).toEqual([0, 1]);
    c.docs.move(api.id, prd.id, 0);
    expect([c.q.doc(api.id)!.position, c.q.doc(ux.id)!.position]).toEqual([0, 1]);
    expect(() => c.docs.move(prd.id, ux.id, 0)).toThrow(ValidationError);
    c.docs.move(ux.id, null, 0);
    expect(c.q.doc(ux.id)).toMatchObject({ parentId: null, position: 0 });
    expect(c.q.doc(prd.id)!.position).toBe(1);
  });

  it("deletes a page with its sub-pages and unlinks it from its issue", () => {
    boot();
    const issue = c.issues.createIssue({ title: "Quiet hours" });
    const prd = c.docs.create({ title: "PRD", issueId: issue.id });
    c.docs.create({ title: "Child", parentId: prd.id });
    expect(c.q.issue(issue.id)!.links).toHaveLength(1);
    c.docs.delete(prd.id);
    expect(c.q.docs()).toHaveLength(0);
    expect(c.q.issue(issue.id)!.links).toHaveLength(0);
  });

  it("versions content and rejects a save based on a stale version", () => {
    boot();
    const doc = c.docs.create({ title: "PRD", body: "v1" });
    expect(doc.version).toBe(1);
    c.docs.update(doc.id, { body: "v2 by agent" }, "agent:x");
    expect(c.q.doc(doc.id)).toMatchObject({ version: 2, updatedBy: "agent:x" });
    expect(() => c.docs.update(doc.id, { body: "mine" }, "user", 1)).toThrow(DocConflictError);
    c.docs.update(doc.id, { body: "mine" }, "user", 2);
    // A no-op save does not create a version.
    c.docs.update(doc.id, { body: "mine" }, "user", 3);
    expect(c.q.doc(doc.id)!.version).toBe(3);
  });

  it("keeps full history and restores an earlier version", () => {
    boot();
    const doc = c.docs.create({ title: "PRD", body: "first" });
    c.docs.update(doc.id, { body: "second" });
    c.docs.update(doc.id, { title: "PRD v2", body: "third" });
    const history = c.docs.history(doc.id);
    expect(history.map((v) => [v.version, v.title, v.body])).toEqual([
      [3, "PRD v2", "third"],
      [2, "PRD", "second"],
      [1, "PRD", "first"],
    ]);
    c.docs.restore(doc.id, 1);
    expect(c.q.doc(doc.id)).toMatchObject({ title: "PRD", body: "first", version: 4 });
  });

  it("lets agents make targeted edits and moves links when the issue changes", async () => {
    boot();
    const a = c.issues.createIssue({ title: "A" });
    const b = c.issues.createIssue({ title: "B" });
    const doc = c.docs.create({ title: "Spec", body: "Timeout is 30s.\nRetries: 3", issueId: a.id });
    const tools = boardTools({ q: c.q, issues: c.issues, docs: c.docs });
    const ctx = { actor: "agent:x" as const, runId: null, issueId: null };
    expect(await callBoardTool(tools, "docs_edit", { doc: doc.id, old_text: "30s", new_text: "45s" }, ctx)).toMatchObject({ text: "Doc edited.", isError: false });
    expect(c.q.doc(doc.id)!.body).toBe("Timeout is 45s.\nRetries: 3");
    expect((await callBoardTool(tools, "docs_edit", { doc: doc.id, old_text: "missing", new_text: "x" }, ctx)).isError).toBe(true);
    c.docs.update(doc.id, { issueId: b.id });
    expect(c.q.issue(a.id)!.links).toHaveLength(0);
    expect(c.q.issue(b.id)!.links.map((l) => l.ref)).toEqual([doc.id]);
  });

  it("imports markdown, Word, and PDF files", async () => {
    boot();
    const md = await importFile({ name: "notes.md", mediaType: "text/markdown", data: Buffer.from("# Notes\n\n- one"), parentId: null, issueId: null }, c.docs, c.assets);
    expect(md).toMatchObject({ title: "notes", body: "# Notes\n\n- one", kind: "markdown" });

    const docx = await importFile({ name: "Quiet_hours.docx", mediaType: "", data: readFileSync("tests/fixtures/sample.docx"), parentId: md.id, issueId: null }, c.docs, c.assets);
    expect(docx.title).toBe("Quiet hours");
    expect(docx.parentId).toBe(md.id);
    expect(docx.body).toContain("# Quiet hours");
    expect(docx.body).toContain("Let people pause **notifications** overnight.");
    expect(docx.body).toMatch(/\| Setting \| Default \|\n\| --- \| --- \|\n\| Start \| 22:00 \|/);

    const pdf = await importFile({ name: "brief.pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-1.4 fake"), parentId: null, issueId: null }, c.docs, c.assets);
    expect(pdf).toMatchObject({ kind: "pdf", title: "brief" });
    expect(readFileSync(c.assets.pathOf(pdf.assetId!).path, "utf8")).toBe("%PDF-1.4 fake");
    await expect(importFile({ name: "x.exe", mediaType: "application/octet-stream", data: Buffer.from("x"), parentId: null, issueId: null }, c.docs, c.assets)).rejects.toThrow(ValidationError);
  });

  it("converts HTML tables without a header row into markdown tables", async () => {
    expect(await htmlToMarkdown("<table><tr><td><p>A</p></td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>")).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });
});
