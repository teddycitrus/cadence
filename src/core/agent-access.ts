import type { Agent, Role } from "./types";

/**
 * What a person may do with an agent: read its instructions, change and run
 * it (`manage`), and decide who sees it or delete it (`own`: its owner, or an
 * admin for public agents). A public agent set to "edit" lets everyone manage it.
 */
export function agentAccess(agent: Pick<Agent, "ownerId" | "visibility" | "publicAccess">, viewer: { memberId: string; role: Role }): { read: boolean; manage: boolean; own: boolean } {
  const mine = agent.ownerId === viewer.memberId;
  if (agent.visibility === "private") return { read: mine, manage: mine, own: mine };
  const own = mine || viewer.role !== "member";
  return { read: true, manage: own || agent.publicAccess === "edit", own };
}

/**
 * An agent as a given person sees it. Others' private agents show only who
 * they are (they can still be assignees on the board), and trigger secrets
 * are only shown to people who can manage the agent.
 */
export function agentForViewer(agent: Agent, viewer: { memberId: string; role: Role }): Agent {
  const access = agentAccess(agent, viewer);
  if (!access.read) return { ...agent, prompt: "", triggers: [], projectId: null };
  if (!access.manage) return { ...agent, triggers: agent.triggers.map((t) => ("secret" in t ? { ...t, secret: "" } : t)) };
  return agent;
}
