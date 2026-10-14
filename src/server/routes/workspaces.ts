import { currentActor } from "../../auth/context";
import { Router } from "express";
import type { Container } from "../container";
import { WorkspaceDelete, WorkspaceFromIssues, WorkspaceInput, WorkspacePatch } from "../schemas";
import { git } from "../../git/git";
import { openFolderIn, openTargets } from "../../workspaces/open-in";
import { z } from "zod";
import { ValidationError } from "../../core/errors";

/**
 * The workspace's files for @-mention search, reused for a few seconds: the search runs on
 * every keystroke, and listing them is a git process each time.
 */
const fileLists = new Map<string, { at: number; out: Promise<string> }>();
function listedFiles(dir: string): Promise<string> {
  const now = Date.now();
  const hit = fileLists.get(dir);
  if (hit && now - hit.at < 5000) return hit.out;
  for (const [k, v] of fileLists) if (now - v.at > 60_000) fileLists.delete(k);
  const out = git(dir, ["ls-files", "--cached", "--others", "--exclude-standard"], true);
  fileLists.set(dir, { at: now, out });
  return out;
}

export function workspaceRoutes(c: Container): Router {
  const r = Router();

  r.post("/", async (req, res) => {
    const input = WorkspaceInput.parse(req.body);
    const ws = await c.workspaces.createInProject(input.projectId, input.name, currentActor());
    const chat = c.engine.createChat({ workspaceId: ws.id });
    const carried = c.workspaces.takeCarried(ws.id);
    if (carried) {
      const text = carried.skipped ?? `Brought over the project folder's uncommitted work: ${carried.copied} file${carried.copied === 1 ? "" : "s"}${carried.deleted ? `, ${carried.deleted} deletion${carried.deleted === 1 ? "" : "s"}` : ""}. The project folder itself is unchanged.`;
      c.store.append({ aggregate: "chat", type: "ChatItemAdded", aggregateId: chat.id, payload: { item: { kind: "notice", tone: carried.skipped ? "warn" : "info", text } } }, "system");
    }
    res.status(201).json({ workspace: ws, chatId: chat.id });
  });

  /** One workspace per issue, each opening with its issue attached and the prompt sent first. */
  r.post("/from-issues", async (req, res) => {
    const input = WorkspaceFromIssues.parse(req.body);
    const created: { workspaceId: string; chatId: string }[] = [];
    for (const issueId of input.issueIds) {
      const issue = c.issues.issueOrThrow(issueId);
      const ws = await c.workspaces.forIssue(issue, currentActor());
      const chat = c.engine.createChat({ workspaceId: ws.id, title: `${issue.key} ${issue.title}`.slice(0, 60), model: input.model, effort: input.effort });
      if (input.prompt.trim()) await c.engine.send(chat.id, { text: input.prompt, mentions: [{ kind: "issue", ref: issue.id }] }, currentActor());
      created.push({ workspaceId: ws.id, chatId: chat.id });
    }
    res.status(201).json({ created });
  });

  r.get("/:id", (req, res) => {
    const ws = c.workspaces.workspaceOrThrow(req.params.id);
    res.json({ workspace: ws, chats: c.q.chatsForWorkspace(ws.id) });
  });

  r.patch("/:id", (req, res) => {
    res.json(c.workspaces.update(req.params.id, WorkspacePatch.parse(req.body)));
  });

  r.post("/:id/archive", async (req, res) => {
    c.terminals.closeWorkspace(req.params.id);
    // Its shells must have exited before the worktree goes (Windows keeps a shell's folder locked).
    await Promise.all([c.terminals.exited(), c.canvasDev.stop(req.params.id)]);
    await c.workspaces.archive(req.params.id);
    res.json({ ok: true });
  });

  r.post("/:id/restore", async (req, res) => {
    await c.workspaces.restore(req.params.id);
    res.json({ ok: true });
  });

  r.delete("/:id", async (req, res) => {
    c.terminals.closeWorkspace(req.params.id);
    // Its shells must have exited before the worktree goes (Windows keeps a shell's folder locked).
    await Promise.all([c.terminals.exited(), c.canvasDev.stop(req.params.id)]);
    await c.workspaces.remove(req.params.id, WorkspaceDelete.parse(req.body ?? {}).deleteBranch);
    res.json({ ok: true });
  });

  /** Apps on this machine that can open the workspace's folder: the file manager and installed editors. */
  r.get("/:id/open-in", (req, res) => {
    c.workspaces.workspaceOrThrow(req.params.id);
    res.json({ targets: openTargets() });
  });

  r.post("/:id/open-in", async (req, res) => {
    const ws = c.workspaces.workspaceOrThrow(req.params.id);
    const { target } = z.object({ target: z.string().regex(/^[a-z]{2,20}$/) }).parse(req.body);
    await c.workspaces.ensureOnDisk(ws);
    try {
      openFolderIn(ws.path, target);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : String(err));
    }
    res.json({ ok: true });
  });

  r.get("/:id/status", async (req, res) => {
    res.json(await c.workspaces.status(req.params.id, typeof req.query.against === "string" ? req.query.against : undefined));
  });

  r.get("/:id/diff", async (req, res) => {
    const path = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json({ diff: await c.workspaces.diff(req.params.id, path, typeof req.query.against === "string" ? req.query.against : undefined) });
  });

  /** File search for @-mentions. */
  r.get("/:id/files", async (req, res) => {
    const ws = c.workspaces.workspaceOrThrow(req.params.id);
    const needle = String(req.query.q ?? "").toLowerCase();
    const out = ws.branch ? await listedFiles(ws.path) : "";
    const files = out.split("\n").filter((f) => f && f.toLowerCase().includes(needle));
    res.json({ files: files.slice(0, 30) });
  });

  return r;
}
