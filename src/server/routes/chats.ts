import { z } from "zod";
import { currentActor } from "../../auth/context";
import { Router } from "express";
import type { Container } from "../container";
import { ChatInput, ChatPatch, ChatTransferInput, InteractionAnswerInput, QueuedEdit, SendInput } from "../schemas";
import { exportChat, forkChat, restoreCheckpoint, transferChat } from "../../chat/transfer";
import { switchProvider } from "../../chat/provider-switch";
import type { ChatDetail } from "../../core/types";

export function chatRoutes(c: Container): Router {
  const r = Router();

  r.post("/", (req, res) => {
    res.status(201).json(c.engine.createChat(ChatInput.parse(req.body)));
  });

  r.get("/:id", (req, res) => {
    const chat = c.engine.chatOrThrow(req.params.id);
    // ?after=seq: only newer items (live updates). ?limit=n (&before=seq): one page of history.
    const after = Number(req.query.after ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 0) || 0, 2000);
    const page = limit && !after ? c.q.chatItemsPage(chat.id, limit, Number(req.query.before ?? 0) || undefined) : { items: c.q.chatItems(chat.id, after), earlier: false };
    const detail: ChatDetail & { earlier: boolean } = { chat, items: page.items, earlier: page.earlier, queued: c.q.queued(chat.id), interactions: c.q.interactions(chat.id) };
    res.json(detail);
  });

  r.patch("/:id", async (req, res) => {
    const patch = ChatPatch.parse(req.body);
    if (patch.provider) switchProvider({ engine: c.engine, store: c.store, q: c.q }, req.params.id, patch.provider);
    if (patch.title) c.engine.rename(req.params.id, patch.title);
    if (patch.mode) await c.engine.setMode(req.params.id, patch.mode);
    if (patch.model) await c.engine.setModel(req.params.id, patch.model);
    if (patch.effort) c.engine.setEffort(req.params.id, patch.effort);
    if (patch.fast !== undefined) c.engine.setFast(req.params.id, patch.fast);
    if (patch.remoteControl !== undefined) c.engine.setRemoteControl(req.params.id, patch.remoteControl);
    if (patch.mcpServers !== undefined) c.engine.setMcpServers(req.params.id, patch.mcpServers);
    if (patch.archived !== undefined) c.engine.archive(req.params.id, patch.archived);
    res.json(c.engine.chatOrThrow(req.params.id));
  });

  /** A copy of the chat up to one of its messages, to try a different direction from there. */
  r.post("/:id/fork", (req, res) => {
    const { upToSeq } = z.object({ upToSeq: z.number().int().min(1) }).parse(req.body);
    res.status(201).json(forkChat({ engine: c.engine, store: c.store, q: c.q }, req.params.id, upToSeq));
  });

  /** Files back to just before one of this chat's messages. */
  r.post("/:id/restore", async (req, res) => {
    const { seq } = z.object({ seq: z.number().int().min(1) }).parse(req.body);
    res.json(await restoreCheckpoint({ engine: c.engine, store: c.store, q: c.q }, req.params.id, seq));
  });

  /** The conversation as a Markdown file. */
  r.get("/:id/export", (req, res) => {
    const md = exportChat(c.q, req.params.id);
    const name = (c.q.chat(req.params.id)?.title ?? "chat").replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "chat";
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.md"`);
    res.send(md);
  });

  /** Moves the chat to another workspace; its history comes along. */
  r.post("/:id/transfer", (req, res) => {
    const { workspaceId } = ChatTransferInput.parse(req.body);
    res.json(transferChat({ engine: c.engine, store: c.store, q: c.q }, req.params.id, workspaceId));
  });

  r.delete("/:id", (req, res) => {
    c.engine.delete(req.params.id);
    res.json({ ok: true });
  });

  r.post("/:id/messages", async (req, res) => {
    const input = SendInput.parse(req.body);
    res.status(202).json(await c.engine.send(req.params.id, input, currentActor(), { steer: input.steer }));
  });

  r.get("/:id/cli", (req, res) => {
    res.json(c.cliMode.status(req.params.id));
  });

  /** CLI mode: open the harness's own terminal UI on this chat's session. */
  r.post("/:id/cli", async (req, res) => {
    const size = req.body && typeof req.body === "object" ? (req.body as { cols?: unknown; rows?: unknown }) : {};
    res.json(await c.cliMode.enter(req.params.id, { cols: typeof size.cols === "number" ? size.cols : undefined, rows: typeof size.rows === "number" ? size.rows : undefined }));
  });

  r.delete("/:id/cli", async (req, res) => {
    res.json(await c.cliMode.exit(req.params.id));
  });

  r.post("/:id/interrupt", async (req, res) => {
    await c.engine.interrupt(req.params.id);
    res.json({ ok: true });
  });

  r.post("/:id/unread", (req, res) => {
    c.engine.markUnread(req.params.id);
    res.json({ ok: true });
  });

  r.post("/:id/read", (req, res) => {
    c.engine.markRead(req.params.id);
    res.json({ ok: true });
  });

  r.patch("/:id/queued/:queuedId", (req, res) => {
    c.engine.editQueued(req.params.id, req.params.queuedId, QueuedEdit.parse(req.body).text);
    res.json({ ok: true });
  });

  r.delete("/:id/queued/:queuedId", (req, res) => {
    c.engine.removeQueued(req.params.id, req.params.queuedId);
    res.json({ ok: true });
  });

  /** Steer: send a queued message into the turn that is running now. */
  r.post("/:id/queued/:queuedId/send-now", async (req, res) => {
    res.json(await c.engine.sendQueuedNow(req.params.id, req.params.queuedId));
  });

  r.post("/interactions/:interactionId", async (req, res) => {
    res.json(await c.engine.resolve(req.params.interactionId, InteractionAnswerInput.parse(req.body)));
  });

  return r;
}
