import { z } from "zod";
import type { AgentCommands } from "../core/agent-commands";
import type { Queries } from "../core/queries";
import type { Agent } from "../core/types";
import { callerOwner } from "./agent-tools";
import { define, type BoardTool, type ToolContext } from "./board-tools";
import { AGENT_TEMPLATES } from "./templates";

const serverUrl = () => (process.env.CADENCE_PUBLIC_URL ?? `http://localhost:${process.env.CADENCE_PORT ?? 4317}`).replace(/\/+$/, "");

/** More agent tools: template details, the assignable directory, run history, deletion, and trigger setup. */
export function moreAgentTools(q: Queries, agents: AgentCommands): BoardTool[] {
  const mine = (name: string, ctx: ToolContext): Agent => {
    const agent = q.agent(name);
    if (!agent || agent.ownerId !== callerOwner(q, ctx)) throw new Error(`No agent of yours named "${name}"`);
    return agent;
  };
  return [
    define({
      name: "agents_template_get",
      description: "A built-in agent template in full: its instructions, triggers, effort, and permission mode. Read it before agents_create with that template when the person wants to review it.",
      shape: { template: z.string() },
      run: (a) => {
        const t = AGENT_TEMPLATES.find((x) => x.id === a.template || x.name.toLowerCase() === a.template.toLowerCase());
        if (!t) throw new Error(`No template "${a.template}". Call agents_templates.`);
        return [`${t.name} (${t.id}): ${t.description}`, `Effort ${t.effort}, permissions ${t.permissionMode}`, `Triggers: ${t.triggers.map((x) => x.kind).join(", ") || "assigned only"}`, `Instructions:\n${t.prompt}`].join("\n");
      },
    }),
    define({
      name: "agents_list_assignable",
      description: "Every enabled agent you can hand work to: your own plus teammates' public ones. Pick by what each does, then assign it with issues_assign or start it with agents_run. Runs happen on the owner's machine.",
      shape: {},
      run: (_a, ctx) => {
        const owner = callerOwner(q, ctx);
        const list = q.agents().filter((a) => a.enabled && (a.ownerId === owner || a.visibility === "public"));
        return list.map((a) => `- "${a.name}" (owner ${q.member(a.ownerId)?.name ?? a.ownerId}): ${a.description || "no description"}`).join("\n") || "No enabled agents.";
      },
    }),
    define({
      name: "agents_list_runs",
      description: "An agent's recent runs, newest first: status, trigger, issue, cost, and summary or error. Teammates' public agents show status and times only.",
      shape: { agent: z.string(), limit: z.number().int().min(1).max(100).optional() },
      run: (a, ctx) => {
        const agent = q.agent(a.agent);
        const owner = callerOwner(q, ctx);
        if (!agent || (agent.ownerId !== owner && agent.visibility !== "public")) throw new Error(`No agent named "${a.agent}"`);
        const full = agent.ownerId === owner;
        const runs = q.runs().filter((r) => r.agentId === agent.id).slice(0, a.limit ?? 20);
        return (
          runs
            .map((r) => {
              const base = `- ${r.createdAt.slice(0, 16).replace("T", " ")} ${r.status} (${r.trigger})`;
              if (!full) return base;
              const issue = r.issueId ? q.issue(r.issueId)?.key : null;
              return `${base}${issue ? ` on ${issue}` : ""}, $${r.costUsd.toFixed(2)}, ${r.numTurns} turns${r.summary ? `: ${r.summary.slice(0, 200)}` : ""}${r.error ? ` [error: ${r.error.slice(0, 200)}]` : ""}`;
            })
            .join("\n") || "No runs yet."
        );
      },
    }),
    define({
      name: "agents_delete",
      description: "Delete one of your own agents. It stops firing and is unassigned from its issues. Ask the person first; set confirm: true.",
      shape: { agent: z.string(), confirm: z.literal(true) },
      run: (a, ctx) => {
        const agent = mine(a.agent, ctx);
        if (`agent:${agent.id}` === ctx.actor) throw new Error("An agent cannot delete itself");
        agents.deleteAgent(agent.id, ctx.actor);
        return `Deleted "${agent.name}".`;
      },
    }),
    define({
      name: "agents_trigger_setup",
      description: "What a person must set up outside Cadence for one of your agents' triggers: the webhook URL, the GitHub payload URL and secret with the steps, the Slack channels, and each schedule in words.",
      shape: { agent: z.string() },
      run: (a, ctx) => {
        const agent = mine(a.agent, ctx);
        const base = serverUrl();
        const lines = agent.triggers.map((t) => {
          switch (t.kind) {
            case "webhook":
              return `Webhook: POST JSON or text to ${base}/api/hooks/agents/${agent.id}/${t.secret}`;
            case "github":
              return `GitHub (${t.events.join(", ")}): in the repository's Settings > Webhooks, add payload URL ${base}/api/hooks/github/${agent.id}, content type application/json, secret ${t.secret}, and pick "Pull requests" and "Pull request reviews". Cadence also watches tracked pull requests on its own without the webhook.`;
            case "slack":
              return `Slack (${t.events.join(", ")}): connect Slack under Settings > Integrations and invite the bot to ${t.channelIds.length ? t.channelIds.join(", ") : "the channels it should watch"}.`;
            case "schedule":
              return `Schedule: ${t.description || t.cron} (cron ${t.cron}${t.timezone ? `, ${t.timezone}` : ""}).`;
            default:
              return `${t.kind.replace(/_/g, " ")}: nothing to set up.`;
          }
        });
        return [`"${agent.name}" is ${agent.enabled ? "enabled" : "disabled (a person enables it under Agents)"}.`, ...lines].join("\n");
      },
    }),
  ];
}
