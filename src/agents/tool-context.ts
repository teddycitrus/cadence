import type { Queries } from "../core/queries";
import type { Project } from "../core/types";
import { memberIdOf } from "../auth/context";
import type { ToolContext } from "./board-tools";

/** The person a tool call acts for: the chat's owner, an agent's owner, or the human actor. */
export function actingMember(q: Queries, ctx: ToolContext): string | null {
  if (ctx.ownerId) return ctx.ownerId;
  if (ctx.actor.startsWith("agent:")) return q.agent(ctx.actor.slice(6))?.ownerId ?? null;
  if (ctx.actor.startsWith("token:")) return null;
  return memberIdOf(ctx.actor);
}

/** A project by name or id, or the calling workspace's project (or the only one). */
export function projectFrom(q: Queries, ctx: ToolContext, ref?: string): Project {
  if (ref) {
    const p = q.projects().find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
    if (!p) throw new Error(`No project named "${ref}"`);
    return p;
  }
  const ws = ctx.workspaceId ? q.workspace(ctx.workspaceId) : null;
  const p = ws?.projectId ? q.project(ws.projectId) : q.projects().length === 1 ? q.projects()[0]! : null;
  if (!p) throw new Error("Pass project: this session is not in a project workspace");
  return p;
}

/** Where people open Cadence, for links in tool results (CADENCE_PUBLIC_URL, else relative). */
export function appUrl(path: string): string {
  const base = (process.env.CADENCE_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return `${base}/#${path}`;
}
