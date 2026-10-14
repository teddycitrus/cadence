import { z } from "zod";
import { define, type BoardTool } from "../../agents/board-tools";
import type { LinearIssue } from "./api";
import type { LinearSync } from "./sync";

const identifier = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).describe("Linear identifier like ENG-123");

function line(li: LinearIssue, cadenceKey: string | undefined): string {
  return `${li.identifier} [${li.state.name}] ${li.title} (${li.url})${cadenceKey ? ` · Cadence ${cadenceKey}` : ""}`;
}

/** Linear tools: reading always, writing only when write-back is on. */
export function linearTools(linear: LinearSync): BoardTool[] {
  const read = [
    define({
      name: "linear_search",
      description: "Search Linear issues by text. Synced issues also exist on the Cadence board (shown with their Cadence key).",
      shape: { query: z.string().min(1).max(200) },
      run: async (a) => (await linear.api().search(a.query)).map((li) => line(li, linear.linked(li)?.key)).join("\n") || "No matching Linear issues.",
    }),
    define({
      name: "linear_get",
      description: "Read one Linear issue with its description and comments.",
      shape: { issue: identifier },
      run: async (a) => {
        const li = await linear.api().issue(a.issue);
        const comments = li.comments.map((c) => `- ${c.user ?? "someone"}: ${c.body}`).join("\n");
        return `${line(li, linear.linked(li)?.key)}\n\n${li.description || "(no description)"}\n\nComments:\n${comments || "- none"}`;
      },
    }),
  ];
  if (!linear.config().writeBack) return read;
  return [
    ...read,
    define({
      name: "linear_comment",
      description: "Comment on a Linear issue (posted as the connected Linear user, marked as from Cadence). Keep it to one or two sentences.",
      shape: { issue: identifier, body: z.string().min(1).max(4000) },
      run: async (a, ctx) => {
        const li = await linear.api().issue(a.issue);
        const who = ctx.actor.startsWith("agent:") ? "an agent" : "a teammate";
        await linear.api().comment(li.id, `${a.body}\n\n_From ${who} via Cadence_`);
        return "Commented on Linear.";
      },
    }),
    define({
      name: "linear_set_state",
      description: "Move a Linear issue to a workflow state by name (e.g. In Progress, In Review, Done).",
      shape: { issue: identifier, state: z.string().min(1).max(80) },
      run: async (a) => {
        const api = linear.api();
        const li = await api.issue(a.issue);
        const states = await api.states(li.team.id);
        const target = states.find((s) => s.name.toLowerCase() === a.state.toLowerCase());
        if (!target) throw new Error(`No state named "${a.state}". States: ${states.map((s) => s.name).join(", ")}`);
        await api.setState(li.id, target.id);
        return `${li.identifier} is now ${target.name}.`;
      },
    }),
  ];
}
