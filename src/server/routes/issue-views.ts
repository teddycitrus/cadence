import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { currentActor } from "../../auth/context";
import { ISSUE_TYPES, PRIORITIES } from "../../core/types";
import { CARD_PROPS, VIEW_GROUPS, VIEW_LAYOUTS, VIEW_ORDERS, VIEW_SCOPES } from "../../core/issue-views";
import { ForbiddenError, NotFoundError } from "../../core/errors";
import { identityOf } from "../auth-middleware";
import type { Container } from "../container";

const ids = z.array(z.string().max(100)).max(100);
const ViewInput = z.object({
  name: z.string().trim().min(1).max(80),
  shared: z.boolean().default(false),
  filters: z.object({ scope: z.enum(VIEW_SCOPES), query: z.string().max(200), priorities: z.array(z.enum(PRIORITIES)), types: z.array(z.enum(ISSUE_TYPES)), labelIds: ids, assigneeIds: ids, projectIds: ids }),
  display: z.object({ layout: z.enum(VIEW_LAYOUTS), groupBy: z.enum(VIEW_GROUPS), orderBy: z.enum(VIEW_ORDERS), showHidden: z.boolean(), subGroupBy: z.enum(VIEW_GROUPS).optional(), properties: z.array(z.enum(CARD_PROPS)).max(20).optional() }),
});

/** Saved board views and the board's AI assistant. */
export function issueViewRoutes(c: Container): Router {
  const r = Router();

  r.post("/views", (req, res) => {
    const input = ViewInput.parse(req.body);
    const id = randomUUID();
    c.store.append({ aggregate: "issueView", type: "IssueViewSaved", aggregateId: id, payload: { ...input, ownerId: identityOf(res).memberId } });
    res.status(201).json(c.q.issueView(id));
  });

  /** Only the owner changes a view; admins may also change shared ones. */
  const editable = (id: string, who: ReturnType<typeof identityOf>) => {
    const view = c.q.issueView(id);
    if (!view || (!view.shared && view.ownerId !== who.memberId)) throw new NotFoundError("View not found");
    if (view.ownerId !== who.memberId && who.role === "member") throw new ForbiddenError("Only its owner or an admin can change this view");
    return view;
  };

  r.put("/views/:id", (req, res) => {
    const view = editable(req.params.id, identityOf(res));
    const input = ViewInput.parse(req.body);
    c.store.append({ aggregate: "issueView", type: "IssueViewSaved", aggregateId: view.id, payload: { ...input, ownerId: view.ownerId } });
    res.json(c.q.issueView(view.id));
  });

  r.delete("/views/:id", (req, res) => {
    const view = editable(req.params.id, identityOf(res));
    c.store.append({ aggregate: "issueView", type: "IssueViewDeleted", aggregateId: view.id, payload: {} });
    res.json({ ok: true });
  });

  /** Stars a view for the viewer; starred views show first. */
  r.put("/views/:id/favorite", (req, res) => {
    const who = identityOf(res);
    const view = c.q.issueView(req.params.id);
    if (!view || (!view.shared && view.ownerId !== who.memberId)) throw new NotFoundError("View not found");
    const on = z.object({ on: z.boolean() }).parse(req.body).on;
    const current = c.q.members().find((m) => m.id === who.memberId)?.favoriteViews ?? [];
    const favoriteViews = on ? [...new Set([...current, view.id])] : current.filter((v) => v !== view.id);
    c.store.append({ aggregate: "member", type: "MemberUpdated", aggregateId: who.memberId, payload: { favoriteViews } });
    res.json({ favoriteViews });
  });

  /** The viewer's board assistant: a chat with the board tools, for triage, planning, and bulk changes. */
  r.post("/assistant", async (_req, res) => {
    const who = identityOf(res);
    if (who.role === "member") throw new ForbiddenError("Only the owner and admins can run chats, since they run on the host machine.");
    const title = "Board assistant";
    const existing = c.q.chats().find((ch) => ch.title === title && !ch.archived && ch.createdBy === currentActor() && !ch.agentId);
    if (existing) return void res.json(existing);
    let ws = c.q.workspaces(false).find((w) => w.name === "Board" && !w.issueId && !w.agentId);
    ws ??= await c.workspaces.createInProject(c.q.projects().length === 1 ? c.q.projects()[0]!.id : null, "Board", currentActor());
    res.status(201).json(c.engine.createChat({ workspaceId: ws.id, title, mode: "acceptEdits" }));
  });

  return r;
}
