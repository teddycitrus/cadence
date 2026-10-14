import type { Queries } from "../core/queries";
import type { Agent, Issue, Run, Workspace } from "../core/types";

function boardRules(q: Queries): string[] {
  const gates = q.stages().filter((s) => s.humanGate).map((s) => s.name);
  return [
    `## Working the board`,
    `- Use the cadence board tools (board_overview, issues_*, docs_*) to read and update issues and docs. Map stages and teammates by role from board_overview rather than assuming exact names.`,
    `- Sign-off stages: ${gates.length ? gates.map((g) => `"${g}"`).join(", ") : "none configured"}. Agents cannot move a card out of a gated stage; when a step ends there, the card waits for a person.`,
    `- Keep issue comments to one or two sentences. Put longer write-ups in a doc linked to the issue.`,
  ];
}

function workspaceContext(ws: Workspace | null, q: Queries): string {
  if (!ws) return "";
  const issue = ws.issueId ? q.issue(ws.issueId) : null;
  const project = ws.projectId ? q.project(ws.projectId) : null;
  const lines = [`## Your workspace`, `You are working in the "${ws.name}" workspace${ws.branch ? ` on git branch ${ws.branch}` : " (a scratch folder, not a git repository)"}.`];
  if (project) lines.push(`Project: ${project.name}. Base branch: ${project.baseBranch}.${project.githubRepo ? ` GitHub: ${project.githubRepo}.` : ""}`);
  if (project?.commands.length) lines.push(`Project commands: ${project.commands.map((c) => `${c.name} (\`${c.command}\`)`).join(", ")}.`);
  if (issue) lines.push(`This workspace belongs to issue ${issue.key}: "${issue.title}". Read it with issues_get when you need the details.`);
  return lines.join("\n");
}

function teamPrompt(q: Queries): string {
  const text = q.settings().systemPrompt.trim();
  return text ? `## Team-wide instructions\n${text}` : "";
}

/** The operating rules every agent receives, followed by its own prompt. */
export function buildInstructions(agent: Agent, q: Queries, ws: Workspace | null = null): string {
  const teammates = q
    .agents()
    .filter((a) => a.id !== agent.id && a.enabled)
    .map((a) => `- "${a.name}": ${a.description}`);

  return [
    `# You are the "${agent.name}" agent on a product team that works through Cadence`,
    `Cadence is the team's board. Work moves through stages as issues; agents do the work and humans approve at a few gates. You are one role in that pipeline. Do your own step well, hand the issue to the next role, and stop.`,
    ...boardRules(q),
    `- Never do a downstream role's job. If the next step belongs to a teammate, assign them with issues_assign and unassign yourself.`,
    `- Talk like a teammate: lead with the crux, skip jargon, link the PR or doc.`,
    teammates.length ? `## Teammates you can hand work to\n${teammates.join("\n")}` : "",
    workspaceContext(ws, q),
    teamPrompt(q),
    `## Your role\n${agent.prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Instructions for a person's own chat in a workspace. */
export function buildChatInstructions(q: Queries, ws: Workspace, docId: string | null = null): string {
  const doc = docId ? q.doc(docId) : null;
  return [
    `# You are pairing with a person on their product team in Cadence`,
    `They are driving: do what they ask in this workspace, and ask when a decision is theirs. You can read and update the team's board and docs on their behalf.`,
    ...boardRules(q),
    workspaceContext(ws, q),
    doc
      ? `## The doc you are helping with\nThis chat is attached to the doc "${doc.title}" (id ${doc.id}). Read it with docs_get before answering questions about it. When asked to change it, make targeted edits with docs_edit; the person may be editing other parts at the same time. Only use docs_update to rewrite the whole doc when asked to.`
      : "",
    teamPrompt(q),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The first message of an agent run: why it started and what it is about. */
export function buildRunPrompt(run: Run, issue: Issue | null, q: Queries): string {
  const parts = [`Trigger: ${run.trigger === "manual" ? "started by hand" : run.trigger.replace(/_/g, " ")}.`];
  if (run.context.trim()) parts.push(run.context.trim());
  if (issue) {
    const stage = q.stage(issue.stageId)?.name ?? "unknown";
    parts.push(`This run is about ${issue.key}: "${issue.title}" (currently in "${stage}"). Read it in full with issues_get before acting.`);
  }
  return parts.join("\n\n");
}
