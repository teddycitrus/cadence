import type { DocStore } from "./db";
import type { DomainEvent } from "./events";
import type { IssueView } from "./issue-views";
import type { Actor, CanvasComment, CanvasEdit, Machine, Member, ShareLink, Skill } from "./types";

/** Read models for the canvas Agent queue, canvas comments, members, and share links. */
export function projectCanvas(s: DocStore, event: DomainEvent, ts: string, actor: Actor): void {
  const id = event.aggregateId;
  switch (event.type) {
    case "MemberJoined": {
      const m: Member = { id, ...event.payload, createdAt: ts };
      s.put("members", id, m, null, ts);
      return;
    }
    case "MemberUpdated": {
      const m = s.get<Member>("members", id);
      if (m) s.put("members", id, { ...m, ...Object.fromEntries(Object.entries(event.payload).filter(([, v]) => v !== undefined)) }, null, m.createdAt);
      return;
    }
    case "MemberRemoved":
      s.delete("members", id);
      return;
    case "SkillSaved": {
      const prev = s.get<Skill>("skills", id);
      const skill: Skill = { id, ...event.payload, createdAt: prev?.createdAt ?? ts, updatedAt: ts };
      s.put("skills", id, skill, skill.ownerId, skill.createdAt);
      return;
    }
    case "SkillDeleted":
      s.delete("skills", id);
      return;
    case "MachineAdded": {
      const m: Machine = { id, ...event.payload, createdAt: ts, lastSeenAt: null, hostname: null, platform: null, version: null };
      s.put("machines", id, m, null, ts);
      return;
    }
    case "MachineConnected": {
      const m = s.get<Machine>("machines", id);
      if (m) s.put("machines", id, { ...m, ...event.payload, lastSeenAt: ts }, null, m.createdAt);
      return;
    }
    case "IssueViewSaved": {
      const prev = s.get<IssueView>("issueViews", id);
      s.put("issueViews", id, { id, ...event.payload, createdAt: prev?.createdAt ?? ts, updatedAt: ts } satisfies IssueView, event.payload.ownerId, prev?.createdAt ?? ts);
      return;
    }
    case "IssueViewDeleted":
      s.delete("issueViews", id);
      return;
    case "MachineRenamed": {
      const m = s.get<Machine>("machines", id);
      if (m) s.put("machines", id, { ...m, name: event.payload.name }, null, m.createdAt);
      return;
    }
    case "MachineRemoved":
      s.delete("machines", id);
      return;
    case "ShareCreated": {
      const link: ShareLink = { id, ...event.payload, createdBy: actor, createdAt: ts, revoked: false };
      s.put("shares", id, link, null, ts);
      return;
    }
    case "ShareRevoked": {
      const link = s.get<ShareLink>("shares", id);
      if (link) s.put("shares", id, { ...link, revoked: true }, null, link.createdAt);
      return;
    }
    case "CanvasEditStaged": {
      const edit: CanvasEdit = { id, ...event.payload, createdAt: ts };
      s.put("canvasEdits", id, edit, edit.workspaceId, ts);
      return;
    }
    case "CanvasEditRemoved":
      s.delete("canvasEdits", id);
      return;
    case "CanvasCommentAdded": {
      const comment: CanvasComment = { id, ...event.payload, author: actor, resolved: false, createdAt: ts };
      s.put("canvasComments", id, comment, comment.workspaceId, ts);
      return;
    }
    case "CanvasCommentResolved": {
      const c = s.get<CanvasComment>("canvasComments", id);
      if (c) s.put("canvasComments", id, { ...c, resolved: event.payload.resolved }, c.workspaceId, c.createdAt);
      return;
    }
    case "CanvasCommentReacted": {
      const c = s.get<CanvasComment>("canvasComments", id);
      if (!c) return;
      const reactions = { ...(c.reactions ?? {}) };
      const who = new Set(reactions[event.payload.reaction] ?? []);
      if (event.payload.on) who.add(actor);
      else who.delete(actor);
      if (who.size) reactions[event.payload.reaction] = [...who];
      else delete reactions[event.payload.reaction];
      s.put("canvasComments", id, { ...c, reactions }, c.workspaceId, c.createdAt);
      return;
    }
    case "CanvasCommentEdited": {
      const c = s.get<CanvasComment>("canvasComments", id);
      if (c) s.put("canvasComments", id, { ...c, body: event.payload.body, editedAt: ts }, c.workspaceId, c.createdAt);
      return;
    }
    case "CanvasCommentMoved": {
      const c = s.get<CanvasComment>("canvasComments", id);
      if (!c) return;
      const { workspaceId, ...rest } = event.payload;
      s.put("canvasComments", id, { ...c, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(workspaceId ? { workspaceId } : {}) }, workspaceId ?? c.workspaceId, c.createdAt);
      // A thread moves with its replies.
      if (workspaceId) for (const reply of s.all<CanvasComment>("canvasComments", "WHERE parent = ?", c.workspaceId)) if (reply.parentId === id) s.put("canvasComments", reply.id, { ...reply, workspaceId }, workspaceId, reply.createdAt);
      return;
    }
    case "CanvasCommentRead": {
      const c = s.get<CanvasComment>("canvasComments", id);
      if (c) s.put("canvasComments", id, { ...c, readBy: { ...(c.readBy ?? {}), [event.payload.memberId]: ts } }, c.workspaceId, c.createdAt);
      return;
    }
    case "CanvasCommentUnread": {
      const c = s.get<CanvasComment>("canvasComments", id);
      if (!c?.readBy?.[event.payload.memberId]) return;
      const { [event.payload.memberId]: _gone, ...rest } = c.readBy;
      s.put("canvasComments", id, { ...c, readBy: rest }, c.workspaceId, c.createdAt);
      return;
    }
    case "CanvasCommentDeleted": {
      const c = s.get<CanvasComment>("canvasComments", id);
      if (!c) return;
      s.delete("canvasComments", id);
      for (const reply of s.all<CanvasComment>("canvasComments", "WHERE parent = ?", c.workspaceId)) {
        if (reply.parentId === id) s.delete("canvasComments", reply.id);
      }
      return;
    }
  }
}
