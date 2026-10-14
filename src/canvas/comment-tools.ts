import { z } from "zod";
import { define, type BoardTool, type ToolContext } from "../agents/board-tools";
import { actingMember } from "../agents/tool-context";
import type { Queries } from "../core/queries";
import { REACTIONS, type Actor, type CanvasComment } from "../core/types";
import { commentInbox } from "./inbox";
import type { CanvasService } from "./service";

const canvasPath = z.string().regex(/\.canvas\.[jt]sx?$/).describe("Repo-relative canvas path");
const Workspace = z.string().optional().describe("Workspace id; defaults to this chat's workspace");

/** Canvas comment threads across workspaces: start, edit, react, resolve, read state, search, and the inbox. */
export function commentTools(canvases: CanvasService, q: Queries): BoardTool[] {
  const name = (actor: Actor) =>
    actor === "user" ? (q.member("me")?.name ?? "owner") : actor.startsWith("member:") ? (q.member(actor.slice(7))?.name ?? "former member") : actor.startsWith("agent:") ? `agent ${q.agent(actor.slice(6))?.name ?? ""}`.trim() : actor;
  const wsOf = (ctx: ToolContext, given?: string) => {
    const id = given ?? ctx.workspaceId;
    if (!id || !q.workspace(id)) throw new Error("Pass workspace: this chat is not in one");
    return id;
  };
  /** Finds a comment anywhere, with its workspace. */
  const locate = (id: string): { ws: string; comment: CanvasComment; root: CanvasComment } => {
    for (const w of q.workspaces(true)) {
      const all = q.canvasComments(w.id);
      const comment = all.find((c) => c.id === id);
      if (comment) return { ws: w.id, comment, root: comment.parentId ? all.find((c) => c.id === comment.parentId)! : comment };
    }
    throw new Error(`Comment ${id} not found`);
  };
  const thread = (ws: string, root: CanvasComment) => [root, ...q.canvasComments(ws).filter((c) => c.parentId === root.id)];
  const render = (ws: string, root: CanvasComment) =>
    [`[${root.id}] ${root.canvasPath}${root.storyId ? ` on ${root.storyId}` : ""} at (${Math.round(root.x)}, ${Math.round(root.y)})${root.resolved ? " (resolved)" : ""} in workspace ${ws}`, ...thread(ws, root).map((c) => `  [${c.id}] ${name(c.author)}: ${c.body}${c.editedAt ? " (edited)" : ""}`)].join("\n");
  return [
    define({
      name: "comments_create_thread",
      description: "Pin a new comment thread on a canvas at a point (canvas coordinates), optionally on one frame. Mention people with @Name to notify them.",
      shape: { workspace: Workspace, path: canvasPath, story: z.string().optional(), x: z.number(), y: z.number(), body: z.string().min(1).max(4000) },
      run: (a, ctx) => {
        const c = canvases.comment(wsOf(ctx, a.workspace), { canvasPath: a.path, storyId: a.story ?? null, x: a.x, y: a.y, parentId: null, body: a.body }, ctx.actor);
        return `Started thread ${c.id}.`;
      },
    }),
    define({
      name: "comments_get_thread",
      description: "One canvas comment thread in full: where it is pinned, every message oldest first with its author, edits, reactions, and image attachments, and whether it is resolved.",
      shape: { thread_id: z.string() },
      run: (a) => {
        const { ws, root } = locate(a.thread_id);
        const lines = [`[${root.id}] ${root.canvasPath}${root.storyId ? ` on ${root.storyId}` : ""} at (${Math.round(root.x)}, ${Math.round(root.y)}) in workspace ${ws}${root.resolved ? ", resolved" : ", open"}`];
        for (const c of thread(ws, root)) {
          const reactions = Object.entries(c.reactions ?? {}).filter(([, who]) => who?.length).map(([emoji, who]) => `${emoji} ${who!.length}`);
          lines.push(`- [${c.id}] ${c.createdAt.slice(0, 16).replace("T", " ")} ${name(c.author)}${c.editedAt ? " (edited)" : ""}: ${c.body}`);
          if (c.attachments?.length) lines.push(`  attachments: ${c.attachments.map((x) => `${x.name} ${x.url}`).join(", ")}`);
          if (reactions.length) lines.push(`  reactions: ${reactions.join(", ")}`);
        }
        return lines.join("\n");
      },
    }),
    define({
      name: "comments_edit",
      description: "Edit a canvas comment you wrote. It shows as edited; mentions are not sent again.",
      shape: { comment_id: z.string(), body: z.string().min(1).max(4000) },
      run: (a, ctx) => {
        const { ws, comment } = locate(a.comment_id);
        if (comment.author !== ctx.actor) throw new Error("You can only edit your own comments");
        canvases.editComment(ws, comment.id, a.body, ctx.actor);
        return "Edited.";
      },
    }),
    define({
      name: "comments_delete",
      description: "Delete a canvas comment you wrote. Deleting the first message removes the whole thread.",
      shape: { comment_id: z.string() },
      run: (a, ctx) => {
        const { comment } = locate(a.comment_id);
        if (comment.author !== ctx.actor) throw new Error("You can only delete your own comments");
        canvases.deleteComment(comment.id, ctx.actor);
        return "Deleted.";
      },
    }),
    define({
      name: "comments_react",
      description: `Add (or remove, with on: false) an emoji reaction on a canvas comment: ${REACTIONS.join(", ")}.`,
      shape: { comment_id: z.string(), emoji: z.enum(REACTIONS), on: z.boolean().optional() },
      run: (a, ctx) => {
        const { ws, comment } = locate(a.comment_id);
        canvases.react(ws, comment.id, a.emoji, a.on ?? true, ctx.actor);
        return a.on === false ? "Removed the reaction." : "Reacted.";
      },
    }),
    define({
      name: "comments_resolve",
      description: "Resolve a canvas comment thread (or reopen it with resolved: false).",
      shape: { thread_id: z.string(), resolved: z.boolean().optional() },
      run: (a, ctx) => {
        const { root } = locate(a.thread_id);
        canvases.resolveComment(root.id, a.resolved ?? true, ctx.actor);
        return a.resolved === false ? "Reopened." : "Resolved.";
      },
    }),
    define({
      name: "comments_mark_read",
      description: "Mark a canvas comment thread read for the person you work for, which also clears it from their inbox.",
      shape: { thread_id: z.string() },
      run: (a, ctx) => {
        const member = actingMember(q, ctx);
        if (!member) throw new Error("Read state belongs to a person; this session has none");
        const { ws, root } = locate(a.thread_id);
        canvases.readThread(ws, root.id, member, ctx.actor);
        return "Marked read.";
      },
    }),
    define({
      name: "comments_inbox",
      description: "Unread canvas comment activity for the person you work for: threads where they were @mentioned, or where someone replied to a thread they are part of. Newest first.",
      shape: {},
      run: (_a, ctx) => {
        const member = actingMember(q, ctx);
        if (!member) throw new Error("The inbox belongs to a person; this session has none");
        return (
          commentInbox(q, member)
            .map((i) => `- [${i.threadId}] ${i.reason} on ${i.canvasPath}${i.storyId ? ` (${i.storyId})` : ""} in workspace ${i.workspaceId}: ${name(i.latest.author)}: ${i.latest.body.slice(0, 200)}`)
            .join("\n") || "Nothing unread."
        );
      },
    }),
    define({
      name: "comments_search",
      description: "Search canvas comments in every workspace for text (case-insensitive). Returns up to 50 matches with their thread.",
      shape: { query: z.string().min(1) },
      run: (a) => {
        const needle = a.query.toLowerCase();
        const hits: string[] = [];
        for (const w of q.workspaces(true)) {
          const all = q.canvasComments(w.id);
          for (const c of all.filter((x) => x.body.toLowerCase().includes(needle))) {
            if (hits.length >= 50) break;
            hits.push(`- [${c.parentId ?? c.id}] ${c.canvasPath} in workspace ${w.id}: ${name(c.author)}: ${c.body.slice(0, 200)}`);
          }
        }
        return hits.join("\n") || "No matching comments.";
      },
    }),
    define({
      name: "comments_threads",
      description: "Canvas comment threads across every workspace, by latest activity, for questions like what feedback needs attention this week. Open ones only unless include_resolved.",
      shape: { since: z.string().optional().describe("ISO date"), include_resolved: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() },
      run: (a) => {
        const since = a.since ? new Date(a.since).toISOString() : "";
        const rows: { at: string; text: string }[] = [];
        for (const w of q.workspaces(true)) {
          for (const root of q.canvasComments(w.id).filter((c) => !c.parentId && (a.include_resolved || !c.resolved))) {
            const at = thread(w.id, root).map((c) => c.editedAt ?? c.createdAt).sort().at(-1)!;
            if (at >= since) rows.push({ at, text: render(w.id, root) });
          }
        }
        return rows.sort((x, y) => y.at.localeCompare(x.at)).slice(0, a.limit ?? 20).map((r) => r.text).join("\n\n") || "No threads.";
      },
    }),
    define({
      name: "comments_canvas_activity",
      description: "Everything said on one canvas, newest first: each message with its thread, author, and whether the thread is resolved.",
      shape: { workspace: Workspace, path: canvasPath },
      run: (a, ctx) => {
        const ws = wsOf(ctx, a.workspace);
        const all = q.canvasComments(ws).filter((c) => c.canvasPath === a.path);
        const resolved = new Set(all.filter((c) => !c.parentId && c.resolved).map((c) => c.id));
        return (
          [...all]
            .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
            .map((c) => `- ${c.createdAt.slice(0, 16).replace("T", " ")} [${c.parentId ?? c.id}${resolved.has(c.parentId ?? c.id) ? ", resolved" : ""}] ${name(c.author)}: ${c.body.slice(0, 200)}`)
            .join("\n") || "No comments on this canvas."
        );
      },
    }),
  ];
}
