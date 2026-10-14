import type { Queries } from "../core/queries";
import type { Actor, CanvasComment, Member } from "../core/types";

export interface InboxItem {
  workspaceId: string;
  threadId: string;
  canvasPath: string;
  storyId: string | null;
  /** Mentioned by name, or someone replied in a thread you are part of. */
  reason: "mention" | "reply";
  latest: { author: Actor; body: string; at: string };
  resolved: boolean;
}

const actorOf = (memberId: string): Actor => (memberId === "me" ? "user" : `member:${memberId}`);

/** Whether a comment @mentions someone, by their name (`@Ada` or `@Ada Lovelace`) or email. */
export function mentions(body: string, member: Pick<Member, "name" | "email">): boolean {
  const lower = body.toLowerCase();
  const names = [member.name, member.name.split(/\s+/)[0] ?? "", member.email].filter((n) => n && n.length > 1).map((n) => n.toLowerCase());
  return names.some((n) => {
    const at = lower.indexOf(`@${n}`);
    // The name must end there, so @Al does not match @Alice.
    return at >= 0 && !/[a-z0-9]/.test(lower[at + n.length + 1] ?? "");
  });
}

/** Threads with something new for a person since they last read them, newest first. */
export function commentInbox(q: Queries, memberId: string): InboxItem[] {
  const member = q.member(memberId);
  if (!member) return [];
  const me = actorOf(memberId);
  const out: InboxItem[] = [];
  for (const ws of q.workspaces(false)) {
    const all = q.canvasComments(ws.id);
    for (const root of all.filter((c) => !c.parentId)) {
      const thread: CanvasComment[] = [root, ...all.filter((c) => c.parentId === root.id)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const readAt = root.readBy?.[memberId] ?? "";
      const fresh = thread.filter((c) => c.author !== me && (c.editedAt ?? c.createdAt) > readAt);
      if (!fresh.length) continue;
      const mentioned = fresh.some((c) => mentions(c.body, member));
      const participant = thread.some((c) => c.author === me);
      if (!mentioned && !participant) continue;
      const last = fresh.at(-1)!;
      out.push({ workspaceId: ws.id, threadId: root.id, canvasPath: root.canvasPath, storyId: root.storyId, reason: mentioned ? "mention" : "reply", latest: { author: last.author, body: last.body, at: last.editedAt ?? last.createdAt }, resolved: root.resolved });
    }
  }
  return out.sort((a, b) => b.latest.at.localeCompare(a.latest.at));
}
