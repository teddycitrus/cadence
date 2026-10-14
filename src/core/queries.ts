import { DocStore, prepared, type Db } from "./db";
import { readSettings } from "./projections";
import type { IssueView } from "./issue-views";
import type { Actor, Agent, Asset, Machine, CanvasComment, CanvasEdit, Chat, Member, PullRequest, ShareLink, Skill, ChatItem, ChatItemData, Comment, Doc, Interaction, Issue, Label, Project, QueuedMessage, Run, Settings, Stage, Workspace } from "./types";

/** Read-side access to the projected tables. */
export class Queries {
  private s: DocStore;

  constructor(private db: Db) {
    this.s = new DocStore(db);
  }

  stages(): Stage[] {
    return this.s.all<Stage>("stages", "ORDER BY sort");
  }

  stage(idOrName: string): Stage | null {
    return this.s.get<Stage>("stages", idOrName) ?? this.stages().find((st) => st.name.toLowerCase() === idOrName.toLowerCase()) ?? null;
  }

  labels(): Label[] {
    return this.s.all<Label>("labels").sort((a, b) => a.name.localeCompare(b.name));
  }

  label(idOrName: string): Label | null {
    return this.s.get<Label>("labels", idOrName) ?? this.labels().find((l) => l.name.toLowerCase() === idOrName.toLowerCase()) ?? null;
  }

  issues(): Issue[] {
    return this.s.all<Issue>("issues", "ORDER BY sort DESC");
  }

  issue(idOrKey: string): Issue | null {
    return this.s.get<Issue>("issues", idOrKey) ?? this.s.all<Issue>("issues", "WHERE lower(json_extract(data, '$.key')) = lower(?) LIMIT 1", idOrKey)[0] ?? null;
  }

  nextIssueNumber(): number {
    const row = prepared(this.db, "SELECT MAX(CAST(sort AS INTEGER)) AS n FROM issues").get() as { n: number | null };
    const fromEvents = prepared(this.db, "SELECT COUNT(*) AS n FROM events WHERE type = 'IssueCreated'").get() as { n: number };
    return Math.max(Number(row.n ?? 0), Number(fromEvents.n)) + 1;
  }

  comments(issueId: string): Comment[] {
    const rows = prepared(this.db, "SELECT * FROM comments WHERE issue_id = ? ORDER BY seq").all(issueId) as {
      seq: number;
      issue_id: string;
      author: Actor;
      body: string;
      ts: string;
      edited_at: string | null;
      reactions: string;
    }[];
    return rows.map((r) => ({ seq: r.seq, issueId: r.issue_id, author: r.author, body: r.body, ts: r.ts, editedAt: r.edited_at, reactions: JSON.parse(r.reactions || "{}") as Comment["reactions"] }));
  }

  projects(): Project[] {
    return this.s.all<Project>("projects").sort((a, b) => a.name.localeCompare(b.name));
  }

  project(id: string): Project | null {
    return this.s.get<Project>("projects", id);
  }

  agents(): Agent[] {
    return this.s.all<Agent>("agents").sort((a, b) => a.name.localeCompare(b.name));
  }

  agent(idOrName: string): Agent | null {
    return this.s.get<Agent>("agents", idOrName) ?? this.agents().find((a) => a.name.toLowerCase() === idOrName.toLowerCase()) ?? null;
  }

  runs(limit = 300): Run[] {
    return this.s.all<Run>("runs", `ORDER BY sort DESC LIMIT ${Math.floor(limit)}`);
  }

  run(id: string): Run | null {
    return this.s.get<Run>("runs", id);
  }

  runsForIssue(issueId: string): Run[] {
    return this.s.all<Run>("runs", "WHERE parent = ? ORDER BY sort DESC", issueId);
  }

  /** The agent's run still waiting in the queue for this issue (runs are filed under their issue) or Slack thread. */
  queuedRunFor(agentId: string, target: { issueId: string } | { threadKey: string }): Run | null {
    const where =
      "issueId" in target
        ? "WHERE parent = ? AND json_extract(data, '$.status') = 'queued' AND json_extract(data, '$.agentId') = ? ORDER BY sort LIMIT 1"
        : "WHERE json_extract(data, '$.status') = 'queued' AND json_extract(data, '$.threadKey') = ? AND json_extract(data, '$.agentId') = ? ORDER BY sort LIMIT 1";
    return this.s.all<Run>("runs", where, "issueId" in target ? target.issueId : target.threadKey, agentId)[0] ?? null;
  }

  activeRuns(): Run[] {
    return this.s.all<Run>("runs", "WHERE json_extract(data, '$.status') IN ('queued', 'running', 'waiting') ORDER BY sort");
  }

  workspaces(includeArchived = true): Workspace[] {
    const all = this.s.all<Workspace>("workspaces", "ORDER BY sort DESC");
    return includeArchived ? all : all.filter((w) => !w.archived);
  }

  workspace(id: string): Workspace | null {
    return this.s.get<Workspace>("workspaces", id);
  }

  workspacesForIssue(issueId: string): Workspace[] {
    return this.workspaces().filter((w) => w.issueId === issueId);
  }

  chats(): Chat[] {
    return this.s.all<Chat>("chats", "ORDER BY sort DESC");
  }

  chat(id: string): Chat | null {
    return this.s.get<Chat>("chats", id);
  }

  chatsForWorkspace(workspaceId: string): Chat[] {
    return this.s.all<Chat>("chats", "WHERE parent = ? ORDER BY sort", workspaceId);
  }

  chatItems(chatId: string, afterSeq = 0): ChatItem[] {
    const rows = prepared(this.db, "SELECT * FROM chat_items WHERE chat_id = ? AND seq > ? ORDER BY seq").all(chatId, afterSeq) as { seq: number; chat_id: string; data: string; ts: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.data) as ChatItemData), seq: r.seq, chatId: r.chat_id, ts: r.ts }));
  }

  /** The latest `limit` items before a seq (or the end), oldest first, and whether older ones exist. */
  chatItemsPage(chatId: string, limit: number, beforeSeq = Number.MAX_SAFE_INTEGER): { items: ChatItem[]; earlier: boolean } {
    const rows = prepared(this.db, "SELECT * FROM chat_items WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(chatId, beforeSeq, limit + 1) as { seq: number; chat_id: string; data: string; ts: string }[];
    const earlier = rows.length > limit;
    return { items: rows.slice(0, limit).reverse().map((r) => ({ ...(JSON.parse(r.data) as ChatItemData), seq: r.seq, chatId: r.chat_id, ts: r.ts })), earlier };
  }

  queued(chatId: string): QueuedMessage[] {
    return this.s.all<QueuedMessage>("queued", "WHERE parent = ? ORDER BY sort", chatId);
  }

  interactions(chatId: string): Interaction[] {
    return this.s.all<Interaction>("interactions", "WHERE parent = ? ORDER BY sort", chatId);
  }

  interaction(id: string): Interaction | null {
    return this.s.get<Interaction>("interactions", id);
  }

  pendingInteractions(): Interaction[] {
    return this.s.all<Interaction>("interactions", "ORDER BY sort").filter((i) => i.status === "pending");
  }

  docs(): Doc[] {
    return this.s.all<Doc>("docs").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  pullRequests(): PullRequest[] {
    return this.s.all<PullRequest>("pullRequests", "ORDER BY sort DESC");
  }

  pullRequest(id: string): PullRequest | null {
    return this.s.get<PullRequest>("pullRequests", id);
  }

  members(): Member[] {
    return this.s.all<Member>("members", "ORDER BY sort");
  }

  member(id: string): Member | null {
    return this.s.get<Member>("members", id);
  }

  skills(ownerId: string): Skill[] {
    return this.s.all<Skill>("skills", "WHERE parent = ? ORDER BY sort", ownerId);
  }

  shares(): ShareLink[] {
    return this.s.all<ShareLink>("shares", "ORDER BY sort DESC");
  }

  share(id: string): ShareLink | null {
    return this.s.get<ShareLink>("shares", id);
  }

  canvasEdits(workspaceId: string): CanvasEdit[] {
    return this.s.all<CanvasEdit>("canvasEdits", "WHERE parent = ? ORDER BY sort", workspaceId);
  }

  canvasComments(workspaceId: string): CanvasComment[] {
    return this.s.all<CanvasComment>("canvasComments", "WHERE parent = ? ORDER BY sort", workspaceId);
  }

  /** Issue id to when this member last opened it. */
  issueReads(memberId: string): Record<string, string> {
    return Object.fromEntries(this.s.all<{ issueId: string; at: string }>("issueReads", "WHERE parent = ?", memberId).map((r) => [r.issueId, r.at]));
  }

  issueViews(): IssueView[] {
    return this.s.all<IssueView>("issueViews", "ORDER BY sort");
  }

  issueView(id: string): IssueView | null {
    return this.s.get<IssueView>("issueViews", id);
  }

  machines(): Machine[] {
    return this.s.all<Machine>("machines", "ORDER BY sort");
  }

  machine(id: string): Machine | null {
    return this.s.get<Machine>("machines", id);
  }

  asset(id: string): Asset | null {
    return this.s.get<Asset>("assets", id);
  }

  doc(id: string): Doc | null {
    return this.s.get<Doc>("docs", id);
  }

  docsForIssue(issueId: string): Doc[] {
    return this.s.all<Doc>("docs", "WHERE parent = ?", issueId);
  }

  settings(): Settings {
    return readSettings(this.s);
  }
}
