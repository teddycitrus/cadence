import { currentActor } from "../../auth/context";
import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { DocInput, DocPatch } from "../schemas";
import { importFile } from "../../docs/importer";
import { generateCanvasesPrompt } from "../../docs/generate-canvases";
import { ForbiddenError, ValidationError } from "../../core/errors";
import { identityOf } from "../auth-middleware";

const MoveInput = z.object({ parentId: z.string().max(100).nullable(), position: z.number().int().min(0).max(10_000) });
const ImportInput = z.object({
  name: z.string().trim().min(1).max(200),
  mediaType: z.string().max(200),
  data: z.string().min(1).max(36_000_000),
  parentId: z.string().max(100).nullish().transform((v) => v || null),
  issueId: z.string().max(100).nullish().transform((v) => v || null),
});

export function docRoutes(c: Container): Router {
  const r = Router();

  r.post("/", (req, res) => {
    res.status(201).json(c.docs.create(DocInput.parse(req.body)));
  });

  r.post("/import", async (req, res) => {
    const input = ImportInput.parse(req.body);
    const doc = await importFile({ ...input, data: Buffer.from(input.data, "base64") }, c.docs, c.assets);
    res.status(201).json(doc);
  });

  r.get("/:id", (req, res) => {
    res.json(c.docs.docOrThrow(req.params.id));
  });

  /** Saves with optimistic concurrency: pass the version you edited as baseVersion. */
  r.patch("/:id", (req, res) => {
    const { baseVersion, collab, ...patch } = DocPatch.parse(req.body);
    const write = () => c.docs.update(req.params.id, patch, currentActor(), baseVersion);
    // A save from a live editing room: the room already has this content.
    res.json(collab ? c.collab.saveFromRoom(req.params.id, patch.body, write) : write());
  });

  r.post("/:id/move", (req, res) => {
    const input = MoveInput.parse(req.body);
    c.docs.move(req.params.id, input.parentId, input.position);
    res.json({ ok: true });
  });

  r.delete("/:id", (req, res) => {
    c.docs.delete(req.params.id);
    res.json({ ok: true });
  });

  r.get("/:id/history", (req, res) => {
    res.json(c.docs.history(req.params.id));
  });

  r.post("/:id/restore/:version", (req, res) => {
    res.json(c.docs.restore(req.params.id, Number(req.params.version)));
  });

  r.get("/:id/export", (req, res) => {
    const doc = c.docs.docOrThrow(req.params.id);
    const name = `${doc.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim() || "doc"}.md`;
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(`# ${doc.title}\n\n${doc.body}\n`);
  });

  /**
   * The doc's assistant chat: lives in the linked issue's workspace when there
   * is one, otherwise in a shared "Docs" workspace. Reused across visits.
   */
  /**
   * Generate canvases from a doc: an agent chat in a workspace (one given, the
   * linked issue's, or a new one in a project) builds them and embeds them.
   */
  r.post("/:id/generate-canvases", async (req, res) => {
    if (identityOf(res).role === "member") throw new ForbiddenError("Only the owner and admins can start agents, since they run on the host machine.");
    const input = z.object({ workspaceId: z.string().max(100).nullish(), projectId: z.string().max(100).nullish(), note: z.string().max(4000).default("") }).parse(req.body ?? {});
    const doc = c.docs.docOrThrow(req.params.id);
    const issue = doc.issueId ? c.q.issue(doc.issueId) : null;
    let ws = input.workspaceId ? c.workspaces.workspaceOrThrow(input.workspaceId) : null;
    if (ws?.archived) throw new ValidationError("That workspace is archived");
    if (!ws && issue && !input.projectId) ws = await c.workspaces.forIssue(issue, currentActor());
    if (!ws) {
      const projectId = input.projectId ?? (c.q.projects().length === 1 ? c.q.projects()[0]!.id : null);
      if (!projectId) throw new ValidationError("Pick the project the canvases belong in");
      ws = await c.workspaces.createInProject(projectId, `Canvases: ${doc.title}`.slice(0, 60), currentActor());
    }
    const chat = c.engine.createChat({ workspaceId: ws.id, title: `Canvases for ${doc.title}`.slice(0, 60), mode: "acceptEdits" });
    await c.engine.send(chat.id, { text: generateCanvasesPrompt(doc, ws, input.note) }, currentActor());
    res.status(201).json({ chatId: chat.id, workspaceId: ws.id });
  });

  r.post("/:id/chat", async (req, res) => {
    const doc = c.docs.docOrThrow(req.params.id);
    const existing = c.q.chats().find((ch) => ch.docId === doc.id && !ch.archived);
    if (existing) {
      res.json(existing);
      return;
    }
    const issue = doc.issueId ? c.q.issue(doc.issueId) : null;
    let ws = issue ? await c.workspaces.forIssue(issue, currentActor()) : c.q.workspaces(false).find((w) => w.name === "Docs" && !w.issueId && !w.agentId);
    ws ??= await c.workspaces.createInProject(c.q.projects().length === 1 ? c.q.projects()[0]!.id : null, "Docs", currentActor());
    res.status(201).json(c.engine.createChat({ workspaceId: ws.id, title: `Doc: ${doc.title}`.slice(0, 60), docId: doc.id, mode: "acceptEdits" }));
  });

  return r;
}
