import { prepared, type Db, type DocStore } from "./db";
import type { DomainEvent } from "./events";
import { defined } from "./projections";
import type { Actor, Chat, Interaction, Issue, PullRequest, QueuedMessage, Run, Workspace } from "./types";

/** Read models for agent runs, workspaces, chats, queued messages, and interactions. */
export function projectChat(db: Db, s: DocStore, event: DomainEvent, seq: number, ts: string, actor: Actor): void {
  const id = event.aggregateId;

  const run = (fn: (r: Run) => void) => {
    const current = s.get<Run>("runs", id);
    if (!current) return;
    fn(current);
    s.put("runs", id, current, current.issueId, current.createdAt);
  };
  const workspace = (fn: (w: Workspace) => void) => {
    const current = s.get<Workspace>("workspaces", id);
    if (!current) return;
    fn(current);
    current.updatedAt = ts;
    s.put("workspaces", id, current, current.projectId, current.createdAt);
  };
  const chat = (fn: (c: Chat) => void, touch = true) => {
    const current = s.get<Chat>("chats", id);
    if (!current) return;
    fn(current);
    if (touch) current.updatedAt = ts;
    s.put("chats", id, current, current.workspaceId, current.createdAt);
  };

  switch (event.type) {
    case "RunQueued": {
      const p = event.payload;
      const queued: Run = {
        id,
        agentId: p.agentId,
        issueId: p.issueId,
        workspaceId: null,
        chatId: null,
        trigger: p.trigger,
        context: p.context,
        threadKey: p.threadKey ?? null,
        status: "queued",
        summary: null,
        error: null,
        costUsd: 0,
        numTurns: 0,
        createdAt: ts,
        startedAt: null,
        finishedAt: null,
      };
      s.put("runs", id, queued, p.issueId, ts);
      return;
    }
    case "RunStarted":
      run((r) => Object.assign(r, { status: "running", startedAt: r.startedAt ?? ts }));
      return;
    case "RunAttached":
      run((r) => Object.assign(r, event.payload));
      return;
    case "RunContextUpdated":
      run((r) => (r.context = event.payload.context));
      return;
    case "RunSucceeded":
    case "RunFailed":
      run((r) => {
        r.status = event.type === "RunSucceeded" ? "succeeded" : "failed";
        if (event.type === "RunSucceeded") r.summary = event.payload.summary;
        else r.error = event.payload.error;
        r.costUsd = event.payload.costUsd;
        r.numTurns = event.payload.numTurns;
        r.finishedAt = ts;
      });
      return;
    case "RunCancelled":
      run((r) => Object.assign(r, { status: "cancelled", finishedAt: ts }));
      return;

    case "WorkspaceCreated": {
      const created: Workspace = { id, ...event.payload, pinned: false, archived: false, createdBy: actor, createdAt: ts, updatedAt: ts };
      s.put("workspaces", id, created, created.projectId, ts);
      if (created.issueId && created.branch) {
        const issue = s.get<Issue>("issues", created.issueId);
        if (issue && !issue.branch) {
          s.put("issues", issue.id, { ...issue, branch: created.branch, worktreePath: created.path, updatedAt: ts }, issue.stageId, issue.key.split("-").pop()!.padStart(8, "0"));
        }
      }
      return;
    }
    case "WorkspaceUpdated":
      workspace((w) => Object.assign(w, defined(event.payload)));
      return;
    case "WorkspaceArchived":
    case "WorkspaceRestored":
      workspace((w) => (w.archived = event.type === "WorkspaceArchived"));
      return;
    case "WorkspaceDeleted":
      s.delete("workspaces", id);
      for (const c of s.all<Chat>("chats", "WHERE parent = ?", id)) s.put("chats", c.id, { ...c, archived: true }, id, c.createdAt);
      return;

    case "ChatCreated": {
      const p = event.payload;
      const created: Chat = {
        id,
        ...p,
        docId: p.docId ?? null,
        threadKey: p.threadKey ?? null,
        createdBy: actor,
        sessionId: null,
        status: "idle",
        unread: false,
        archived: false,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        slashCommands: [],
        createdAt: ts,
        updatedAt: ts,
      };
      s.put("chats", id, created, p.workspaceId, ts);
      return;
    }
    case "ChatUpdated":
      chat((c) => Object.assign(c, defined(event.payload)));
      return;
    case "ChatSessionStarted":
      chat((c) => Object.assign(c, event.payload, { carryOver: false }), false);
      return;
    case "ChatStatusChanged":
      chat((c) => {
        c.status = event.payload.status;
        c.stoppedByRestart = event.payload.reason === "restart" ? true : undefined;
      });
      return;
    case "ChatItemAdded":
      prepared(db, "INSERT INTO chat_items (seq, chat_id, data, ts) VALUES (?, ?, ?, ?)").run(seq, id, JSON.stringify(event.payload.item), ts);
      // Anything the assistant produces marks the chat unread until a person opens it.
      chat((c) => {
        if (event.payload.item.kind !== "user") c.unread = true;
      });
      return;
    case "ChatUsage":
      chat((c) => {
        c.costUsd += event.payload.costUsd;
        c.inputTokens += event.payload.inputTokens;
        c.outputTokens += event.payload.outputTokens;
      }, false);
      return;
    case "ChatRead":
      chat((c) => (c.unread = false), false);
      return;
    case "ChatMarkedUnread":
      chat((c) => (c.unread = true), false);
      return;
    case "ChatForked":
      chat((c) => Object.assign(c, { sessionId: null, carryOver: true, forkedFrom: event.payload.fromChatId }));
      return;
    case "ChatTransferred":
      chat((c) => Object.assign(c, { workspaceId: event.payload.toWorkspaceId, sessionId: null, carryOver: true }));
      return;
    case "ChatArchived":
      chat((c) => (c.archived = event.payload.archived));
      return;
    case "ChatDeleted":
      s.delete("chats", id);
      prepared(db, "DELETE FROM chat_items WHERE chat_id = ?").run(id);
      for (const q of s.all<QueuedMessage>("queued", "WHERE parent = ?", id)) s.delete("queued", q.id);
      return;

    case "MessageQueued": {
      const p = event.payload;
      s.put("queued", p.queuedId, { id: p.queuedId, chatId: id, text: p.text, attachments: p.attachments, createdAt: ts } satisfies QueuedMessage, id, ts);
      return;
    }
    case "QueuedMessageEdited": {
      const q = s.get<QueuedMessage>("queued", event.payload.queuedId);
      if (q) s.put("queued", q.id, { ...q, text: event.payload.text }, id, q.createdAt);
      return;
    }
    case "QueuedMessageRemoved":
      s.delete("queued", event.payload.queuedId);
      return;

    case "PullRequestTracked": {
      const p = event.payload;
      const pr: PullRequest = {
        id,
        url: p.url,
        repo: p.repo,
        number: p.number,
        issueId: p.issueId,
        workspaceId: p.workspaceId,
        title: `#${p.number}`,
        state: "open",
        merged: false,
        draft: false,
        headRef: "",
        headSha: "",
        checks: "none",
        checkRuns: [],
        review: "none",
        refreshedAt: null,
        error: null,
      };
      s.put("pullRequests", id, pr, p.issueId, ts);
      return;
    }
    case "PullRequestUpdated": {
      const pr = s.get<PullRequest>("pullRequests", id);
      if (!pr) return;
      const { transitions: _t, ...fields } = event.payload;
      s.put("pullRequests", id, { ...pr, ...fields, refreshedAt: ts, error: null }, pr.issueId, ts);
      return;
    }
    case "PullRequestRefreshFailed": {
      const pr = s.get<PullRequest>("pullRequests", id);
      if (pr) s.put("pullRequests", id, { ...pr, error: event.payload.error, refreshedAt: ts }, pr.issueId, ts);
      return;
    }
    case "PullRequestLinked": {
      const pr = s.get<PullRequest>("pullRequests", id);
      if (!pr) return;
      const next = { ...pr, issueId: event.payload.issueId ?? pr.issueId, workspaceId: event.payload.workspaceId ?? pr.workspaceId };
      s.put("pullRequests", id, next, next.issueId, ts);
      return;
    }
    case "InteractionRequested": {
      const p = event.payload;
      const interaction: Interaction = {
        id: p.interactionId,
        chatId: id,
        runId: p.runId,
        kind: p.kind,
        toolName: p.toolName,
        input: p.input,
        questions: p.questions,
        plan: p.plan,
        status: "pending",
        resolution: null,
        createdAt: ts,
      };
      s.put("interactions", p.interactionId, interaction, id, ts);
      chat((c) => (c.status = "waiting"));
      return;
    }
    case "InteractionResolved": {
      const it = s.get<Interaction>("interactions", event.payload.interactionId);
      if (it) s.put("interactions", it.id, { ...it, status: event.payload.status, resolution: event.payload.resolution }, id, it.createdAt);
      const stillWaiting = s.all<Interaction>("interactions", "WHERE parent = ?", id).some((x) => x.status === "pending");
      chat((c) => {
        if (c.status === "waiting" && !stillWaiting) c.status = "running";
      });
      return;
    }
  }
}
