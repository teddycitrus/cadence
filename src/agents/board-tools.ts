import { z } from "zod";
import type { IssueCommands } from "../core/issue-commands";
import type { DocCommands } from "../docs/commands";
import type { PullRequestService } from "../git/pull-requests";
import type { Queries } from "../core/queries";
import { ISSUE_TYPES, PRIORITIES, type Actor, type Assignee, type Issue } from "../core/types";

export interface ToolContext {
  actor: Actor;
  runId: string | null;
  issueId: string | null;
  /** The workspace the calling session runs in, for git and PR tools. */
  workspaceId?: string | null;
  /** The person whose chat this is, for personal skills. */
  ownerId?: string | null;
}

/** A tool result with pictures, such as a rendered frame the agent should look at. */
export interface ToolOutput {
  text: string;
  images: { data: string; mimeType: "image/png" | "image/jpeg" }[];
}

export interface BoardTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<string | ToolOutput> | string | ToolOutput;
}

export const define = <S extends z.ZodRawShape>(tool: BoardTool<S>): BoardTool => tool as unknown as BoardTool;

export interface BoardDeps {
  q: Queries;
  issues: IssueCommands;
  docs: DocCommands;
  prs?: PullRequestService;
  /** Tools contributed by connected integrations (Slack, Linear). */
  extra?: BoardTool[];
}

function describeIssue(q: Queries, i: Issue): string {
  const stage = q.stage(i.stageId)?.name ?? i.stageId;
  const labels = i.labelIds.map((l) => q.label(l)?.name ?? l).join(", ");
  const assignees = i.assignees.map((a) => (a.kind === "user" ? (a.id === "me" ? "me" : `"${q.member(a.id)?.name ?? "former member"}"`) : `agent "${q.agent(a.id)?.name ?? a.id}"`)).join(", ");
  return `${i.key} [${stage}] ${i.title} (type ${i.type}, priority ${i.priority}${labels ? `, labels: ${labels}` : ""}${assignees ? `, assignees: ${assignees}` : ""})`;
}

function resolveAssignee(q: Queries, who: string): Assignee {
  if (who === "me" || who === "user") return { kind: "user", id: "me" };
  const needle = who.trim().toLowerCase();
  const member = q.members().find((m) => m.id === who || m.name.toLowerCase() === needle || (m.email && m.email === needle));
  if (member) return { kind: "user", id: member.id };
  const agent = q.agent(who);
  if (!agent) throw new Error(`No agent or member named "${who}". Call board_overview for the list.`);
  return { kind: "agent", id: agent.id };
}

/** The tools every agent gets for reading and working the board. */
export function boardTools({ q, issues, docs, prs, extra = [] }: BoardDeps): BoardTool[] {
  return [
    ...(prs ? prTools(q, prs) : []),
    ...extra,
    define({
      name: "board_overview",
      description:
        "The board's configuration: stages in order (with category and whether each is a sign-off stage), labels, members (the human user and every agent with its role), and projects. Call this first to map columns and teammates by role rather than by exact name.",
      shape: {},
      run: () => {
        const stages = q.stages().map((s) => `- ${s.name} (id ${s.id}; ${s.category}${s.humanGate ? "; SIGN-OFF STAGE: agents cannot move cards out" : ""}${s.hidden ? "; hidden" : ""})`);
        const labels = q.labels().map((l) => `- ${l.name}`);
        const agents = q.agents().map((a) => `- agent "${a.name}"${a.enabled ? "" : " (disabled)"}: ${a.description}`);
        const projects = q.projects().map((p) => `- ${p.name} (${p.path}, base ${p.baseBranch}${p.githubRepo ? `, GitHub ${p.githubRepo}` : ""})`);
        const people = q.members().filter((m) => m.id !== "me").map((m) => `- "${m.name}" (${m.role}, a person${m.email ? `, ${m.email}` : ""})`);
        return [`Stages:\n${stages.join("\n")}`, `Labels:\n${labels.join("\n") || "- none"}`, `Members:\n- "me" (the human product owner)\n${[...people, ...agents].join("\n")}`, `Projects:\n${projects.join("\n") || "- none"}`].join("\n\n");
      },
    }),
    define({
      name: "issues_list",
      description: "List issues, optionally filtered by stage name, assignee (\"me\" or an agent name), label name, or a text query. Returns one line per issue.",
      shape: {
        stage: z.string().optional(),
        assignee: z.string().optional(),
        label: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      run: (a) => {
        let list = q.issues();
        if (a.stage) {
          const st = q.stage(a.stage);
          if (!st) throw new Error(`Unknown stage "${a.stage}"`);
          list = list.filter((i) => i.stageId === st.id);
        }
        if (a.assignee) {
          const who = resolveAssignee(q, a.assignee);
          list = list.filter((i) => i.assignees.some((x) => x.kind === who.kind && x.id === who.id));
        }
        if (a.label) {
          const label = q.label(a.label);
          list = label ? list.filter((i) => i.labelIds.includes(label.id)) : [];
        }
        if (a.query) {
          const needle = a.query.toLowerCase();
          list = list.filter((i) => `${i.title}\n${i.body}`.toLowerCase().includes(needle));
        }
        const shown = list.slice(0, a.limit ?? 50);
        return shown.map((i) => describeIssue(q, i)).join("\n") || "No matching issues.";
      },
    }),
    define({
      name: "issues_get",
      description: "Everything about one issue: fields, body, comments, links (docs, PRs, branches), and linked docs' titles.",
      shape: { issue: z.string().describe("Issue key like CAD-12") },
      run: (a) => {
        const i = issues.issueOrThrow(a.issue);
        const who = (a: string) => (a === "user" ? "me" : a.startsWith("agent:") ? `agent "${q.agent(a.slice(6))?.name ?? "deleted"}"` : a.startsWith("chat:") ? "AI assistant (on behalf of me)" : a.startsWith("token:") ? "outside agent (MCP)" : a);
        const comments = q.comments(i.id).map((c) => `- ${who(c.author)}: ${c.body}`);
        const links = i.links.map((l) => `- ${l.kind}: ${l.title} (${l.ref})`);
        return [
          describeIssue(q, i),
          i.branch ? `Branch: ${i.branch}` : "",
          `\n${i.body || "(no description)"}`,
          `\nLinks:\n${links.join("\n") || "- none"}`,
          `\nComments:\n${comments.join("\n") || "- none"}`,
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),
    define({
      name: "issues_create",
      description: "File a new issue. Search with issues_list first so you update an existing issue instead of filing a duplicate.",
      shape: {
        title: z.string().min(1).max(200),
        body: z.string().describe("Markdown description with the evidence and context an engineer needs"),
        type: z.enum(ISSUE_TYPES),
        priority: z.enum(PRIORITIES),
        stage: z.string().optional().describe("Stage name; defaults to the first stage"),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional().describe('"me" or agent names'),
      },
      run: (a, ctx) => {
        const created = issues.createIssue(
          { title: a.title, body: a.body, type: a.type, priority: a.priority, stageId: a.stage, labelIds: a.labels, assignees: (a.assignees ?? []).map((w) => resolveAssignee(q, w)) },
          ctx.actor,
        );
        return `Created ${created.key}.`;
      },
    }),
    define({
      name: "issues_update",
      description: "Edit an issue's title, markdown body, type, priority, estimate (in points), or start and due dates (YYYY-MM-DD, null to clear).",
      shape: {
        issue: z.string(),
        title: z.string().min(1).max(200).optional(),
        body: z.string().optional(),
        type: z.enum(ISSUE_TYPES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        estimate: z.number().min(0).max(100).nullable().optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      },
      run: (a, ctx) => {
        const { issue, ...patch } = a;
        const updated = issues.updateIssue(issue, patch, ctx.actor);
        return `Updated ${updated.key}.`;
      },
    }),
    define({
      name: "issues_move",
      description: "Move an issue to another stage. Agents cannot move cards out of a human-gate stage; leave those for a person.",
      shape: { issue: z.string(), stage: z.string().describe("Stage name or id") },
      run: (a, ctx) => {
        const moved = issues.moveIssue(a.issue, a.stage, ctx.actor);
        return `${moved.key} is now in ${q.stage(moved.stageId)?.name}.`;
      },
    }),
    define({
      name: "issues_label",
      description: "Add or remove a label on an issue.",
      shape: { issue: z.string(), label: z.string(), add: z.boolean() },
      run: (a, ctx) => {
        issues.setLabel(a.issue, a.label, a.add, ctx.actor);
        return `${a.add ? "Added" : "Removed"} label ${a.label}.`;
      },
    }),
    define({
      name: "issues_assign",
      description: 'Add or remove an assignee: "me" for the human, or an agent by name. Assigning an agent hands it the issue and starts its run.',
      shape: { issue: z.string(), assignee: z.string(), add: z.boolean() },
      run: (a, ctx) => {
        issues.setAssignee(a.issue, resolveAssignee(q, a.assignee), a.add, ctx.actor);
        return `${a.add ? "Assigned" : "Unassigned"} ${a.assignee}.`;
      },
    }),
    define({
      name: "issues_comment",
      description: "Post a short comment on an issue (one or two sentences). Put longer write-ups in a doc linked to the issue.",
      shape: { issue: z.string(), body: z.string().min(1).max(2000) },
      run: (a, ctx) => {
        issues.comment(a.issue, a.body, ctx.actor);
        return "Comment posted.";
      },
    }),
    define({
      name: "issues_link",
      description: "Attach a link to an issue: a pull request URL, a branch name, a doc id, or any URL.",
      shape: { issue: z.string(), kind: z.enum(["doc", "pr", "branch", "url", "linear"]), ref: z.string().min(1), title: z.string().optional() },
      run: (a, ctx) => {
        issues.addLink(a.issue, { kind: a.kind, ref: a.ref, title: a.title }, ctx.actor);
        return "Linked.";
      },
    }),
    define({
      name: "docs_list",
      description: "List docs, optionally only those linked to an issue or matching a text query.",
      shape: { issue: z.string().optional(), query: z.string().optional() },
      run: (a) => {
        let docs = a.issue ? q.docsForIssue(issues.issueOrThrow(a.issue).id) : q.docs();
        if (a.query) docs = docs.filter((d) => `${d.title}\n${d.body}`.toLowerCase().includes(a.query!.toLowerCase()));
        return docs.map((d) => `- ${d.title} (id ${d.id}${d.issueId ? `, issue ${q.issue(d.issueId)?.key}` : ""})`).join("\n") || "No docs.";
      },
    }),
    define({
      name: "docs_get",
      description: "Read a doc's markdown.",
      shape: { doc: z.string() },
      run: (a) => {
        const d = q.doc(a.doc);
        if (!d) throw new Error(`Doc ${a.doc} not found`);
        return `# ${d.title}\n(version ${d.version})\n\n${d.body}`;
      },
    }),
    define({
      name: "docs_create",
      description: `Create a markdown doc (a PRD, plan, or write-up). Pass an issue key to link it to that issue, or a parent doc id to nest it as a sub-page. ${EMBED_HINT}`,
      shape: { title: z.string().min(1).max(200), body: z.string(), issue: z.string().optional(), parent: z.string().optional() },
      run: (a, ctx) => `Created doc ${docs.create({ title: a.title, body: a.body, issueId: a.issue ?? null, parentId: a.parent ?? null }, ctx.actor).id}.`,
    }),
    define({
      name: "docs_edit",
      description: "Replace one exact passage of a doc with new text. Prefer this over docs_update for changes to a doc people may be editing; old_text must appear exactly once.",
      shape: { doc: z.string(), old_text: z.string().min(1), new_text: z.string() },
      run: (a, ctx) => {
        docs.edit(a.doc, a.old_text, a.new_text, ctx.actor);
        return "Doc edited.";
      },
    }),
    define({
      name: "docs_update",
      description: `Replace a doc's title and/or its whole markdown body. Use docs_edit for targeted changes. ${EMBED_HINT}`,
      shape: { doc: z.string(), title: z.string().min(1).max(200).optional(), body: z.string().optional(), version: z.number().int().min(1).optional().describe("The version you read (docs_get shows it); the write is refused if someone changed the doc since") },
      run: (a, ctx) => `Doc updated to version ${docs.update(a.doc, { title: a.title, body: a.body }, ctx.actor, a.version).version}.`,
    }),
  ];
}

const EMBED_HINT = "To show a canvas or one frame in a doc, add a fenced block with language canvas whose lines are `workspace: <workspace id>`, `path: <file>.canvas.tsx`, and optionally `story: <export name>`; it renders as a live preview.";

/** Pull request tools, available when GitHub support is wired in. */
function prTools(q: Queries, prs: PullRequestService): BoardTool[] {
  return [
    define({
      name: "pr_open",
      description:
        "Push this workspace's branch and open a GitHub pull request for it (or return the one already open). Commit your work first. The PR is linked to the workspace's issue and Cadence tracks its checks and reviews.",
      shape: { title: z.string().min(1).max(200), body: z.string().min(1).describe("Markdown: what changed, why, and how it was tested"), draft: z.boolean().optional() },
      run: async (a, ctx) => {
        if (!ctx.workspaceId) throw new Error("pr_open only works from a workspace chat");
        const pr = await prs.open(ctx.workspaceId, { title: a.title, body: a.body, draft: a.draft }, ctx.actor);
        return `Pull request #${pr.number} is open: ${pr.url}`;
      },
    }),
    define({
      name: "pr_status",
      description: "The state of a pull request: open, merged, or closed; CI checks (with failing check names); and the review decision. Defaults to this workspace's PR, or pass an issue key.",
      shape: { issue: z.string().optional() },
      run: async (a, ctx) => {
        const issue = a.issue ? q.issue(a.issue) : null;
        if (a.issue && !issue) throw new Error(`Issue ${a.issue} not found`);
        const pr = issue ? q.pullRequests().find((p) => p.issueId === issue.id) : ctx.workspaceId ? await prs.forWorkspace(ctx.workspaceId) : null;
        if (!pr) return "No pull request found.";
        await prs.refresh(pr.id);
        const fresh = q.pullRequest(pr.id)!;
        const failing = fresh.checkRuns.filter((r) => r.conclusion && !["success", "skipped", "neutral"].includes(r.conclusion)).map((r) => r.name);
        return [
          `#${fresh.number} ${fresh.title} (${fresh.url})`,
          `State: ${fresh.merged ? "merged" : fresh.state}${fresh.draft ? " (draft)" : ""}`,
          `Checks: ${fresh.checks}${failing.length ? ` (failing: ${failing.join(", ")})` : ""}`,
          `Review: ${fresh.review.replace("_", " ")}`,
          fresh.error ? `Last refresh error: ${fresh.error}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),
  ];
}

/** Runs a tool by name with validated input. Used by the MCP adapter and by tests. */
export async function callBoardTool(tools: BoardTool[], name: string, input: unknown, ctx: ToolContext): Promise<{ text: string; isError: boolean; images: ToolOutput["images"] }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool ${name}`, isError: true, images: [] };
  const parsed = z.object(tool.shape).safeParse(input ?? {});
  if (!parsed.success) return { text: `Invalid input: ${parsed.error.message}`, isError: true, images: [] };
  try {
    const out = await tool.run(parsed.data, ctx);
    return typeof out === "string" ? { text: out, isError: false, images: [] } : { ...out, isError: false };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true, images: [] };
  }
}

/** MCP content blocks for a tool result: its text, then any images. */
export function toolContent(result: { text: string; images: ToolOutput["images"] }) {
  return [{ type: "text" as const, text: result.text }, ...result.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))];
}
