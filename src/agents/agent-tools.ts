import { z } from "zod";
import type { AgentCommands } from "../core/agent-commands";
import type { Queries } from "../core/queries";
import { EFFORTS, type Agent } from "../core/types";
import { define, type BoardTool, type ToolContext } from "./board-tools";
import { AGENT_TEMPLATES } from "./templates";
import { agentAccess } from "../core/agent-access";

function triggersOf(triggers: { kind: string }[]): string {
  return triggers.map((t) => t.kind.replace(/_/g, " ")).join(", ") || "manual only";
}

/** The person a tool call acts for: the chat's or token's owner, or the calling agent's owner. */
export function callerOwner(q: Queries, ctx: ToolContext): string {
  if (ctx.ownerId) return ctx.ownerId;
  if (ctx.actor.startsWith("agent:")) return q.agent(ctx.actor.slice(6))?.ownerId ?? "me";
  if (ctx.actor.startsWith("member:")) return ctx.actor.slice(7);
  return "me";
}

/**
 * Tools for managing the team's agents. Agents an agent creates start
 * disabled, and only a person can enable one, so no agent can grow the
 * pipeline on its own. Someone else's private agents are invisible here.
 */
export function agentTools(q: Queries, agents: AgentCommands): BoardTool[] {
  const visible = (ctx: ToolContext) => {
    const owner = callerOwner(q, ctx);
    return (a: Agent) => a.visibility === "public" || a.ownerId === owner;
  };
  const find = (name: string, ctx: ToolContext): Agent => {
    const agent = q.agent(name);
    if (!agent || !visible(ctx)(agent)) throw new Error(`No agent named "${name}". Call agents_list.`);
    return agent;
  };
  return [
    define({
      name: "agents_list",
      description: "List the team's agents: name, enabled, triggers, and what each does.",
      shape: {},
      run: (_a, ctx) =>
        q
          .agents()
          .filter(visible(ctx))
          .map((a) => `- "${a.name}"${a.enabled ? "" : " (disabled)"}${a.visibility === "private" ? " (private)" : ""}: ${a.description || "no description"} [triggers: ${triggersOf(a.triggers)}; ${a.model}, effort ${a.effort}]`)
          .join("\n") || "No agents yet.",
    }),
    define({
      name: "agents_get",
      description: "Read one agent's full instructions and settings.",
      shape: { agent: z.string().min(1) },
      run: (a, ctx) => {
        const agent = find(a.agent, ctx);
        return [`"${agent.name}" (${agent.enabled ? "enabled" : "disabled"}, ${agent.visibility}), ${agent.model}, effort ${agent.effort}, permissions ${agent.permissionMode}`, `Triggers: ${triggersOf(agent.triggers)}`, `Description: ${agent.description || "none"}`, `Instructions:\n${agent.prompt}`].join("\n");
      },
    }),
    define({
      name: "agents_templates",
      description: "Search the starting templates for new agents (all of them without a query). agents_template_get shows one in full.",
      shape: { query: z.string().optional() },
      run: (a) => {
        const words = (a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const hits = AGENT_TEMPLATES.filter((t) => words.every((w) => `${t.id} ${t.name} ${t.description}`.toLowerCase().includes(w)));
        return hits.map((t) => `- ${t.id}: ${t.name}. ${t.description}`).join("\n") || "No template matches; try fewer words.";
      },
    }),
    define({
      name: "agents_create",
      description: "Create a new agent, from a template or from scratch. It starts disabled and private; a person reviews, enables, and shares it.",
      shape: {
        name: z.string().min(1).max(60),
        description: z.string().max(300).optional(),
        prompt: z.string().min(1).max(20_000).optional().describe("Instructions; defaults to the template's"),
        template: z.string().optional().describe("Template id from agents_templates"),
        effort: z.enum(EFFORTS).optional(),
      },
      run: (a, ctx) => {
        const t = a.template ? AGENT_TEMPLATES.find((x) => x.id === a.template) : null;
        if (a.template && !t) throw new Error(`No template "${a.template}". Call agents_templates.`);
        if (!t && !a.prompt) throw new Error("Give instructions (prompt) or a template");
        const agent = agents.createAgent(
          {
            name: a.name,
            description: a.description ?? t?.description ?? "",
            prompt: a.prompt ?? t!.prompt,
            color: t?.color,
            effort: a.effort ?? t?.effort,
            permissionMode: t?.permissionMode,
            triggers: t?.triggers ?? [],
            templateId: t?.id ?? null,
            enabled: false,
            ownerId: callerOwner(q, ctx),
          },
          ctx.actor,
        );
        return `Created "${agent.name}", disabled. Ask a person to review and enable it under Agents.`;
      },
    }),
    define({
      name: "agents_update",
      description: "Change an agent's instructions or description, or disable it. Enabling is left to a person.",
      shape: { agent: z.string().min(1), prompt: z.string().min(1).max(20_000).optional(), description: z.string().max(300).optional(), disable: z.boolean().optional() },
      run: (a, ctx) => {
        const agent = find(a.agent, ctx);
        const caller = callerOwner(q, ctx);
        if (!agentAccess(agent, { memberId: caller, role: caller === "me" ? "owner" : (q.member(caller)?.role ?? "member") }).manage) throw new Error(`"${agent.name}" belongs to someone else, who has not opened it for editing; copy it to make your own`);
        if (`agent:${agent.id}` === ctx.actor && a.prompt) throw new Error("An agent cannot rewrite its own instructions");
        if (a.prompt !== undefined || a.description !== undefined) agents.updateAgent(agent.id, { ...(a.prompt !== undefined ? { prompt: a.prompt } : {}), ...(a.description !== undefined ? { description: a.description } : {}) }, ctx.actor);
        if (a.disable) agents.setEnabled(agent.id, false, ctx.actor);
        return `Updated "${agent.name}".`;
      },
    }),
    define({
      name: "agents_run",
      description: "Start an agent now, optionally on an issue, with a note explaining what to do.",
      shape: { agent: z.string().min(1), issue: z.string().optional(), note: z.string().max(4000).optional() },
      run: (a, ctx) => {
        const agent = find(a.agent, ctx);
        if (!agent.enabled) throw new Error(`"${agent.name}" is disabled`);
        if (`agent:${agent.id}` === ctx.actor) throw new Error("An agent cannot start itself");
        const issue = a.issue ? q.issue(a.issue) : null;
        if (a.issue && !issue) throw new Error(`Issue ${a.issue} not found`);
        const runId = agents.queueRun({ agentId: agent.id, issueId: issue?.id ?? null, trigger: "manual", context: a.note ?? "" }, ctx.actor);
        return runId ? `Queued "${agent.name}"${issue ? ` on ${issue.key}` : ""}.` : "Not queued (loop guard or disabled).";
      },
    }),
  ];
}
