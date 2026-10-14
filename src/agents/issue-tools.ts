import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import type { EventStore } from "../core/event-store";
import type { IssueCommands } from "../core/issue-commands";
import type { Queries } from "../core/queries";
import { DEFAULT_DISPLAY, DEFAULT_FILTERS, VIEW_GROUPS, VIEW_LAYOUTS, VIEW_ORDERS, VIEW_SCOPES, orderIssues } from "../core/issue-views";
import { ISSUE_TYPES, PRIORITIES, STAGE_CATEGORIES, type Actor, type Issue, type Stage, type StoredEvent } from "../core/types";
import type { AssetStore } from "../docs/assets";
import type { ShareService } from "../share/service";
import { define, type BoardTool, type ToolContext } from "./board-tools";
import { actingMember, appUrl } from "./tool-context";

export interface IssueToolDeps {
  q: Queries;
  issues: IssueCommands;
  store: EventStore;
  shares: ShareService;
  assets: AssetStore;
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const Keys = z.array(z.string().min(1)).min(1).max(100);

function who(q: Queries, actor: Actor): string {
  if (actor === "user") return q.member("me")?.name ?? "owner";
  if (actor.startsWith("member:")) return q.member(actor.slice(7))?.name ?? "former member";
  if (actor.startsWith("agent:")) return `agent ${q.agent(actor.slice(6))?.name ?? "(deleted)"}`;
  if (actor.startsWith("chat:")) return "assistant";
  if (actor.startsWith("token:")) return "outside agent";
  return actor;
}

const line = (q: Queries, i: Issue) => {
  const assignees = i.assignees.map((a) => (a.kind === "user" ? (q.member(a.id)?.name ?? a.id) : `agent ${q.agent(a.id)?.name ?? a.id}`));
  const labels = i.labelIds.map((l) => q.label(l)?.name ?? l);
  return `${i.key} [${q.stage(i.stageId)?.name ?? i.stageId}] ${i.title} (${i.type}, ${i.priority}${labels.length ? `, labels ${labels.join("/")}` : ""}${assignees.length ? `, ${assignees.join(", ")}` : ""})`;
};

/** Stages in board order, visible ones only, grouped by category order. */
function pipeline(q: Queries): Stage[] {
  const cat = (s: Stage) => STAGE_CATEGORIES.indexOf(s.category);
  return q.stages().filter((s) => !s.hidden).sort((a, b) => cat(a) - cat(b) || a.position - b.position);
}

function describeEvent(q: Queries, e: StoredEvent): string {
  const p = e.payload as Record<string, any>;
  const stage = (id: string) => q.stage(id)?.name ?? id;
  switch (e.type) {
    case "IssueCreated":
      return `created in ${stage(p.stageId)}`;
    case "IssueMoved":
      return `moved ${stage(p.from)} -> ${stage(p.to)}${p.auto ? ` (automatic, ${p.auto.replace("_", " ")})` : ""}`;
    case "IssueUpdated":
      return `changed ${Object.keys(p).join(", ")}`;
    case "LabelAdded":
    case "LabelRemoved":
      return `${e.type === "LabelAdded" ? "added" : "removed"} label ${q.label(p.labelId)?.name ?? p.labelId}`;
    case "AssigneeAdded":
    case "AssigneeRemoved":
      return `${e.type === "AssigneeAdded" ? "assigned" : "unassigned"} ${p.assignee.kind === "user" ? (q.member(p.assignee.id)?.name ?? p.assignee.id) : `agent ${q.agent(p.assignee.id)?.name ?? p.assignee.id}`}`;
    case "CommentAdded":
      return `commented: ${String(p.body).slice(0, 160)}`;
    case "LinkAdded":
      return `linked ${p.link.kind} ${p.link.title || p.link.ref}`;
    case "IssueRanked":
      return "reordered";
    default:
      return e.type;
  }
}

/** Issue-board tools beyond the basics in board-tools: search, bulk edits, ordering, views, reports. */
export function issueTools({ q, issues, store, shares, assets }: IssueToolDeps): BoardTool[] {
  const byKey = (keys: string[]) => keys.map((k) => issues.issueOrThrow(k));
  return [
    define({
      name: "issues_search",
      description: "Search issues by text (key, title, body) with optional filters on stage, priority, type, label, and assignee. Sorted by manual board order unless order is given.",
      shape: {
        query: z.string().optional(),
        stages: z.array(z.string()).optional().describe("Stage names or ids"),
        priorities: z.array(z.enum(PRIORITIES)).optional(),
        types: z.array(z.enum(ISSUE_TYPES)).optional(),
        label: z.string().optional(),
        assignee: z.string().optional().describe('"me", a member name, an agent name, or "none"'),
        order: z.enum(VIEW_ORDERS).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      run: (a) => {
        const needle = a.query?.trim().toLowerCase();
        const stageIds = a.stages?.map((s) => {
          const st = q.stage(s);
          if (!st) throw new Error(`Unknown stage "${s}"`);
          return st.id;
        });
        const label = a.label ? q.label(a.label) : null;
        if (a.label && !label) return "No matching issues.";
        const assignee = a.assignee?.toLowerCase();
        const list = q.issues().filter((i) => {
          if (needle && !`${i.key} ${i.title} ${i.body}`.toLowerCase().includes(needle)) return false;
          if (stageIds && !stageIds.includes(i.stageId)) return false;
          if (a.priorities && !a.priorities.includes(i.priority)) return false;
          if (a.types && !a.types.includes(i.type)) return false;
          if (label && !i.labelIds.includes(label.id)) return false;
          if (assignee) {
            if (assignee === "none") return i.assignees.length === 0;
            const names = i.assignees.map((x) => (x.kind === "user" ? (x.id === "me" ? "me" : (q.member(x.id)?.name ?? "").toLowerCase()) : (q.agent(x.id)?.name ?? "").toLowerCase()));
            if (!names.includes(assignee) && !i.assignees.some((x) => x.id === a.assignee)) return false;
          }
          return true;
        });
        const sorted = orderIssues(list, a.order ?? "manual").slice(0, a.limit ?? 50);
        return sorted.map((i) => line(q, i)).join("\n") || "No matching issues.";
      },
    }),
    define({
      name: "issues_find_my_work",
      description: "Issues assigned to the person you work for (or to you, when you are an agent), grouped by stage category, open work first.",
      shape: { include_done: z.boolean().optional() },
      run: (a, ctx) => {
        const agentId = ctx.actor.startsWith("agent:") ? ctx.actor.slice(6) : null;
        const member = agentId ? null : actingMember(q, ctx);
        const mine = q.issues().filter((i) => i.assignees.some((x) => (agentId ? x.kind === "agent" && x.id === agentId : x.kind === "user" && x.id === member)));
        const open = mine.filter((i) => a.include_done || !["done", "cancelled"].includes(q.stage(i.stageId)?.category ?? ""));
        return open.map((i) => line(q, i)).join("\n") || "Nothing assigned.";
      },
    }),
    define({
      name: "issues_reorder",
      description: "Place an issue under manual board ordering by naming its new neighbors: `above` is the issue that should sit directly above it, `below` directly below (omit one for the top or bottom of the column). Optionally move it to a stage at the same time.",
      shape: { issue: z.string(), above: z.string().optional(), below: z.string().optional(), stage: z.string().optional() },
      run: (a, ctx) => {
        const moved = issues.reorderIssue(a.issue, { above: a.above, below: a.below, stage: a.stage }, ctx.actor);
        return `${moved.key} placed${a.stage ? ` in ${q.stage(moved.stageId)?.name}` : ""}.`;
      },
    }),
    define({
      name: "issues_edit_body",
      description: "Replace one exact passage of an issue's markdown body instead of rewriting it all, so edits others made elsewhere in it survive. old_text must appear exactly once (add surrounding text if not); set replace_all for every occurrence.",
      shape: { issue: z.string(), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() },
      run: (a, ctx) => {
        const i = issues.issueOrThrow(a.issue);
        const count = i.body.split(a.old_text).length - 1;
        if (count === 0) throw new Error("That passage is not in the issue body; read it again with issues_get");
        if (count > 1 && !a.replace_all) throw new Error(`That passage appears ${count} times; include more surrounding text or set replace_all`);
        const body = a.replace_all ? i.body.split(a.old_text).join(a.new_text) : i.body.replace(a.old_text, () => a.new_text);
        issues.updateIssue(i.id, { body }, ctx.actor);
        return `Edited ${i.key} (${a.replace_all ? count : 1} replacement${(a.replace_all ? count : 1) === 1 ? "" : "s"}).`;
      },
    }),
    define({
      name: "issues_duplicate",
      description: "Copy an issue (title, body, type, priority, stage, labels) under a new key, with nobody assigned.",
      shape: { issue: z.string() },
      run: (a, ctx) => `Created ${issues.duplicateIssue(a.issue, ctx.actor).key}.`,
    }),
    define({
      name: "issues_delete",
      description: "Delete an issue permanently. Ask the person first. Set confirm: true to proceed.",
      shape: { issue: z.string(), confirm: z.literal(true) },
      run: (a, ctx) => {
        const i = issues.issueOrThrow(a.issue);
        issues.deleteIssue(i.id, ctx.actor);
        return `Deleted ${i.key}.`;
      },
    }),
    define({
      name: "issues_bulk_update",
      description: "Change up to 100 issues at once: move them to a stage, set priority or type, add or remove a label, add or remove an assignee. Each issue goes through the same rules as a single change (sign-off stages still apply).",
      shape: {
        issues: Keys,
        stage: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        type: z.enum(ISSUE_TYPES).optional(),
        add_label: z.string().optional(),
        remove_label: z.string().optional(),
        add_assignee: z.string().optional(),
        remove_assignee: z.string().optional(),
      },
      run: (a, ctx) => {
        const resolve = (name: string) => {
          if (name === "me") return { kind: "user" as const, id: "me" };
          const m = q.members().find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
          if (m) return { kind: "user" as const, id: m.id };
          const ag = q.agent(name);
          if (!ag) throw new Error(`No member or agent named "${name}"`);
          return { kind: "agent" as const, id: ag.id };
        };
        const done: string[] = [];
        const failed: string[] = [];
        for (const i of byKey(a.issues)) {
          try {
            if (a.priority || a.type) issues.updateIssue(i.id, { ...(a.priority ? { priority: a.priority } : {}), ...(a.type ? { type: a.type } : {}) }, ctx.actor);
            if (a.stage) issues.moveIssue(i.id, a.stage, ctx.actor);
            if (a.add_label) issues.setLabel(i.id, a.add_label, true, ctx.actor);
            if (a.remove_label) issues.setLabel(i.id, a.remove_label, false, ctx.actor);
            if (a.add_assignee) issues.setAssignee(i.id, resolve(a.add_assignee), true, ctx.actor);
            if (a.remove_assignee) issues.setAssignee(i.id, resolve(a.remove_assignee), false, ctx.actor);
            done.push(i.key);
          } catch (err) {
            failed.push(`${i.key}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return [`Updated ${done.length}: ${done.join(", ") || "none"}.`, ...(failed.length ? [`Failed:\n${failed.join("\n")}`] : [])].join("\n");
      },
    }),
    define({
      name: "issues_bulk_delete",
      description: "Delete up to 100 issues permanently. Ask the person first. Set confirm: true to proceed.",
      shape: { issues: Keys, confirm: z.literal(true) },
      run: (a, ctx) => {
        const list = byKey(a.issues);
        for (const i of list) issues.deleteIssue(i.id, ctx.actor);
        return `Deleted ${list.map((i) => i.key).join(", ")}.`;
      },
    }),
    define({
      name: "issues_share_link",
      description: "A link to an issue. By default the member link (teammates sign in to open it). With public: true, a read-only link anyone can open without signing in; only make one when the person asks.",
      shape: { issue: z.string(), public: z.boolean().optional() },
      run: (a, ctx) => {
        const i = issues.issueOrThrow(a.issue);
        if (!a.public) return appUrl(`/issues/${i.key}`);
        return appUrl(`/share/${shares.create("issue", i.id, ctx.actor).id}`);
      },
    }),
    define({
      name: "issues_activity",
      description: "An issue's history, oldest first: creation, stage moves, edits, labels, assignments, comments, and links, with who did each and when.",
      shape: { issue: z.string(), limit: z.number().int().min(1).max(500).optional() },
      run: (a) => {
        const i = issues.issueOrThrow(a.issue);
        const events = store.forAggregate("issue", i.id).filter((e) => e.type !== "IssueRead");
        return events.slice(-(a.limit ?? 100)).map((e) => `${e.ts.slice(0, 16).replace("T", " ")} ${who(q, e.actor)}: ${describeEvent(q, e)}`).join("\n");
      },
    }),
    define({
      name: "issues_board_summary",
      description: "A summary of the board: issue counts by stage, priority, type, and assignee, plus the latest activity.",
      shape: {},
      run: () => {
        const all = q.issues();
        const count = (key: (i: Issue) => string[]) => {
          const m = new Map<string, number>();
          for (const i of all) for (const k of key(i)) m.set(k, (m.get(k) ?? 0) + 1);
          return [...m].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
        };
        const recent = store
          .ofTypesSince(["IssueCreated", "IssueMoved", "CommentAdded", "AssigneeAdded"], new Date(Date.now() - 7 * 86_400_000).toISOString())
          .slice(-15)
          .reverse()
          .map((e) => `- ${e.ts.slice(0, 16).replace("T", " ")} ${q.issue(e.aggregateId)?.key ?? "(deleted)"} ${who(q, e.actor)}: ${describeEvent(q, e)}`);
        return [
          `${all.length} issues.`,
          `By stage: ${count((i) => [q.stage(i.stageId)?.name ?? "?"])}`,
          `By priority: ${count((i) => [i.priority])}`,
          `By type: ${count((i) => [i.type])}`,
          `By assignee: ${count((i) => (i.assignees.length ? i.assignees.map((x) => (x.kind === "user" ? (q.member(x.id)?.name ?? x.id) : `agent ${q.agent(x.id)?.name ?? x.id}`)) : ["unassigned"]))}`,
          `Last 7 days:\n${recent.join("\n") || "- nothing"}`,
        ].join("\n");
      },
    }),
    define({
      name: "issues_suggest_stage",
      description: "The next stage for an issue in this board's pipeline (visible stages in order). At the end of a category it suggests the first stage of the next one. Says when the current stage is a sign-off stage.",
      shape: { issue: z.string() },
      run: (a) => {
        const i = issues.issueOrThrow(a.issue);
        const stages = pipeline(q);
        const here = stages.findIndex((s) => s.id === i.stageId);
        const current = q.stage(i.stageId);
        const next = here >= 0 ? stages[here + 1] : stages[0];
        if (!next) return `${i.key} is in ${current?.name}, the last stage.`;
        return `${i.key} is in ${current?.name}${current?.humanGate ? " (a sign-off stage: a person moves it on)" : ""}. Next: ${next.name} (id ${next.id}, ${next.category}).`;
      },
    }),
    define({
      name: "issues_lifecycle_report",
      description: 'Stage changes in a time window: which issues moved where, when, and by whom. Use for "what moved to Merged this week" style questions; filter by destination stage.',
      shape: { since: z.string().describe("ISO date or time"), until: z.string().optional(), to_stage: z.string().optional() },
      run: (a) => {
        const to = a.to_stage ? q.stage(a.to_stage) : null;
        if (a.to_stage && !to) throw new Error(`Unknown stage "${a.to_stage}"`);
        const until = a.until ?? "9999";
        const moves = store.ofTypesSince(["IssueMoved", "IssueCreated"], new Date(a.since).toISOString()).filter((e) => e.ts <= until);
        const rows = moves
          .filter((e) => (to ? (e.type === "IssueMoved" ? (e.payload as { to: string }).to : (e.payload as { stageId: string }).stageId) === to.id : true))
          .map((e) => `${e.ts.slice(0, 16).replace("T", " ")} ${q.issue(e.aggregateId)?.key ?? "(deleted)"} ${q.issue(e.aggregateId)?.title ?? ""} - ${who(q, e.actor)}: ${describeEvent(q, e)}`);
        return rows.join("\n") || "No stage changes in that window.";
      },
    }),
    define({
      name: "issues_pr_report",
      description: "Pull requests linked to issues, with when Cadence started tracking each, whether it merged and when, review state, checks, and the issue's assignees. Use for PR throughput and review-time questions.",
      shape: { since: z.string().optional().describe("Only PRs tracked since this ISO date") },
      run: (a) => {
        const since = a.since ? new Date(a.since).toISOString() : "";
        const rows = q.pullRequests().flatMap((pr) => {
          const events = store.forAggregate("pr", pr.id);
          const tracked = events.find((e) => e.type === "PullRequestTracked")?.ts ?? "";
          if (since && tracked < since) return [];
          const merged = events.find((e) => e.type === "PullRequestUpdated" && (e.payload as { merged?: boolean }).merged)?.ts ?? null;
          const issue = pr.issueId ? q.issue(pr.issueId) : null;
          const people = issue?.assignees.map((x) => (x.kind === "user" ? (q.member(x.id)?.name ?? x.id) : `agent ${q.agent(x.id)?.name ?? x.id}`)).join(", ");
          return [`#${pr.number} ${pr.title} (${pr.repo}) issue ${issue?.key ?? "none"}; tracked ${tracked.slice(0, 16)}; ${merged ? `merged ${merged.slice(0, 16)}` : pr.state}; review ${pr.review}; checks ${pr.checks}${people ? `; assignees ${people}` : ""}`];
        });
        return rows.join("\n") || "No pull requests.";
      },
    }),
    define({
      name: "issues_links",
      description: "Everything linked to an issue: docs, pull requests, branches, URLs, Linear issues, workspaces, and chats, with link ids for issues_unlink.",
      shape: { issue: z.string() },
      run: (a) => {
        const i = issues.issueOrThrow(a.issue);
        const links = i.links.map((l) => `- ${l.kind}: ${l.title || l.ref} (${l.ref}; link id ${l.id})`);
        const docs = q.docsForIssue(i.id).map((d) => `- doc: ${d.title} (id ${d.id})`);
        const ws = q.workspacesForIssue(i.id).map((w) => `- workspace: ${w.name}${w.branch ? ` on ${w.branch}` : ""} (id ${w.id})`);
        const prs = q.pullRequests().filter((p) => p.issueId === i.id).map((p) => `- pull request #${p.number}: ${p.title} (${p.url})`);
        return [...links, ...docs, ...prs, ...ws].join("\n") || "Nothing linked.";
      },
    }),
    define({
      name: "issues_unlink",
      description: "Remove a link from an issue by its link id (from issues_links).",
      shape: { issue: z.string(), link_id: z.string() },
      run: (a, ctx) => {
        issues.removeLink(a.issue, a.link_id, ctx.actor);
        return "Unlinked.";
      },
    }),
    define({
      name: "labels_list",
      description: "Every label on the board with how many issues carry it.",
      shape: {},
      run: () => q.labels().map((l) => `- ${l.name} (${l.color}, ${q.issues().filter((i) => i.labelIds.includes(l.id)).length} issues)`).join("\n") || "No labels.",
    }),
    define({
      name: "labels_create",
      description: "Create a label on the board.",
      shape: { name: z.string().min(1).max(50), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() },
      run: (a, ctx) => {
        if (q.label(a.name)) return `Label ${a.name} already exists.`;
        issues.createLabel({ name: a.name, color: a.color ?? "#8b5cf6" }, ctx.actor);
        return `Created label ${a.name}.`;
      },
    }),
    define({
      name: "members_list",
      description: "People in the organization (possible assignees) with their role, plus the agents that can be assigned.",
      shape: {},
      run: () =>
        [
          ...q.members().map((m) => `- ${m.name} (${m.id === "me" ? "owner, assign as \"me\"" : m.role}${m.email ? `, ${m.email}` : ""})`),
          ...q.agents().filter((ag) => ag.enabled).map((ag) => `- agent ${ag.name}: ${ag.description}`),
        ].join("\n"),
    }),
    define({
      name: "views_list",
      description: "Saved board views you can see: your own and shared ones, with their filters and layout.",
      shape: {},
      run: (_a, ctx) => {
        const me = actingMember(q, ctx);
        return q.issueViews().filter((v) => v.shared || v.ownerId === me).map((v) => `- ${v.name} (id ${v.id}${v.shared ? ", shared" : ""}): ${JSON.stringify({ filters: v.filters, display: v.display })}`).join("\n") || "No saved views.";
      },
    }),
    define({
      name: "views_save",
      description: "Create a saved board view, or replace one you own (pass id). Filters: scope (all, mine, agents, active, awaiting), query, priorities, types, labels (names), assignees (member or agent names). Display: layout (board, list, timeline), group_by, order_by.",
      shape: {
        id: z.string().optional(),
        name: z.string().min(1).max(80),
        shared: z.boolean().optional(),
        scope: z.enum(VIEW_SCOPES).optional(),
        query: z.string().max(200).optional(),
        priorities: z.array(z.enum(PRIORITIES)).optional(),
        types: z.array(z.enum(ISSUE_TYPES)).optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
        layout: z.enum(VIEW_LAYOUTS).optional(),
        group_by: z.enum(VIEW_GROUPS).optional(),
        order_by: z.enum(VIEW_ORDERS).optional(),
      },
      run: (a, ctx) => {
        const owner = actingMember(q, ctx);
        if (!owner) throw new Error("Saved views belong to a person; this session has none");
        const existing = a.id ? q.issueView(a.id) : null;
        if (a.id && (!existing || existing.ownerId !== owner)) throw new Error("View not found among yours");
        const labelIds = (a.labels ?? []).map((n) => q.label(n)?.id ?? n);
        const assigneeIds = (a.assignees ?? []).map((n) => (n === "me" || n === "none" ? n : (q.members().find((m) => m.name.toLowerCase() === n.toLowerCase())?.id ?? q.agent(n)?.id ?? n)));
        const filters = { ...(existing?.filters ?? DEFAULT_FILTERS), ...(a.scope ? { scope: a.scope } : {}), ...(a.query !== undefined ? { query: a.query } : {}), ...(a.priorities ? { priorities: a.priorities } : {}), ...(a.types ? { types: a.types } : {}), ...(a.labels ? { labelIds } : {}), ...(a.assignees ? { assigneeIds } : {}) };
        const display = { ...(existing?.display ?? DEFAULT_DISPLAY), ...(a.layout ? { layout: a.layout } : {}), ...(a.group_by ? { groupBy: a.group_by } : {}), ...(a.order_by ? { orderBy: a.order_by } : {}) };
        const id = existing?.id ?? randomUUID();
        store.append({ aggregate: "issueView", type: "IssueViewSaved", aggregateId: id, payload: { name: a.name, ownerId: owner, shared: a.shared ?? existing?.shared ?? false, filters, display } }, ctx.actor);
        return `Saved view ${a.name} (id ${id}).`;
      },
    }),
    define({
      name: "views_delete",
      description: "Delete a saved view you own. Set confirm: true to proceed.",
      shape: { id: z.string(), confirm: z.literal(true) },
      run: (a, ctx) => {
        const view = q.issueView(a.id);
        if (!view || view.ownerId !== actingMember(q, ctx)) throw new Error("View not found among yours");
        store.append({ aggregate: "issueView", type: "IssueViewDeleted", aggregateId: view.id, payload: {} }, ctx.actor);
        return `Deleted view ${view.name}.`;
      },
    }),
    define({
      name: "issues_upload_image",
      description: "Upload an image (a screenshot you captured, or one in the repo) so it can be shown in an issue body or comment. Pass a local absolute path (local sessions only) or base64 data. Returns markdown to paste: ![alt](url).",
      shape: { path: z.string().optional(), data: z.string().optional().describe("Base64 image bytes"), name: z.string().optional(), alt: z.string().optional() },
      run: (a, ctx: ToolContext) => {
        let bytes: Buffer;
        let name = a.name ?? "image.png";
        if (a.path) {
          // Outside agents reach Cadence over the network; they may not read files on this machine.
          if (ctx.actor.startsWith("token:")) throw new Error("Outside agents pass data, not a path");
          if (!isAbsolute(a.path)) throw new Error("Use an absolute path");
          if (!IMAGE_TYPES[extname(a.path).toLowerCase()]) throw new Error("Only .png, .jpg, .gif, and .webp images");
          if (statSync(a.path).size > 10 * 1024 * 1024) throw new Error("Images are limited to 10 MB");
          bytes = readFileSync(a.path);
          name = a.name ?? a.path.replace(/^.*[\\/]/, "");
        } else if (a.data) {
          bytes = Buffer.from(a.data, "base64");
        } else throw new Error("Pass path or data");
        const type = IMAGE_TYPES[extname(name).toLowerCase()] ?? (bytes.subarray(1, 4).toString() === "PNG" ? "image/png" : null);
        if (!type) throw new Error("Could not tell the image type; name it .png, .jpg, .gif, or .webp");
        const asset = assets.save(name, type, bytes, ctx.actor);
        return `![${a.alt ?? name}](/api/assets/${asset.id})`;
      },
    }),
  ];
}
