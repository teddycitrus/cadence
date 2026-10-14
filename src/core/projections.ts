import { DocStore, prepared, type Db } from "./db";
import { DEFAULT_SETTINGS } from "./defaults";
import type { DomainEvent } from "./events";
import type { Actor, Agent, Asset, Doc, Issue, Label, Project, Settings, Stage } from "./types";
import { projectChat } from "./projections-chat";
import { projectCanvas } from "./projections-canvas";

const pad = (n: number) => String(n).padStart(8, "0");

/** Patch fields left undefined mean "unchanged", not "clear". */
export function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function readSettings(store: DocStore): Settings {
  return { ...DEFAULT_SETTINGS, ...(store.get<Partial<Settings>>("settings", "global") ?? {}) };
}

/** Applies one event to the read models. Must be deterministic. */
export function project(db: Db, event: DomainEvent, seq: number, ts: string, actor: Actor): void {
  const s = new DocStore(db);
  const id = event.aggregateId;

  const issue = (fn: (i: Issue) => void) => {
    const current = s.get<Issue>("issues", id);
    if (!current) return;
    fn(current);
    current.updatedAt = ts;
    current.updatedBy = actor;
    s.put("issues", id, current, current.stageId, current.key.split("-").pop()!.padStart(8, "0"));
  };
  const doc = <T extends object>(table: "stages" | "labels" | "projects" | "agents" | "docs", fn: (d: T) => void, parent?: (d: T) => string | null) => {
    const current = s.get<T>(table, id);
    if (!current) return;
    fn(current);
    s.put(table, id, current, parent ? parent(current) : null);
  };

  switch (event.type) {
    case "StageCreated":
      s.put("stages", id, { id, ...event.payload } satisfies Stage, null, pad(event.payload.position));
      return;
    case "StageUpdated":
      doc<Stage>("stages", (st) => Object.assign(st, defined(event.payload)));
      return;
    case "StagesReordered":
      event.payload.order.forEach((stageId, position) => {
        const st = s.get<Stage>("stages", stageId);
        if (st) s.put("stages", stageId, { ...st, position }, null, pad(position));
      });
      return;
    case "StageDeleted":
      for (const i of s.all<Issue>("issues", "WHERE parent = ?", id)) {
        s.put("issues", i.id, { ...i, stageId: event.payload.moveIssuesTo, updatedAt: ts }, event.payload.moveIssuesTo, i.key.split("-").pop()!.padStart(8, "0"));
      }
      s.delete("stages", id);
      return;

    case "LabelCreated":
      s.put("labels", id, { id, ...event.payload } satisfies Label);
      return;
    case "LabelUpdated":
      doc<Label>("labels", (l) => Object.assign(l, defined(event.payload)));
      return;
    case "LabelDeleted":
      s.delete("labels", id);
      for (const i of s.all<Issue>("issues")) {
        if (i.labelIds.includes(id)) s.put("issues", i.id, { ...i, labelIds: i.labelIds.filter((l) => l !== id) }, i.stageId, i.key.split("-").pop()!.padStart(8, "0"));
      }
      return;

    case "IssueCreated": {
      const p = event.payload;
      const created: Issue = {
        id,
        key: p.key,
        title: p.title,
        body: p.body,
        type: p.type,
        priority: p.priority,
        estimate: null,
        stageId: p.stageId,
        labelIds: p.labelIds,
        assignees: [],
        projectId: p.projectId,
        branch: null,
        worktreePath: null,
        links: [],
        createdBy: actor,
        createdAt: ts,
        updatedAt: ts,
      };
      s.put("issues", id, created, p.stageId, p.key.split("-").pop()!.padStart(8, "0"));
      return;
    }
    case "IssueUpdated":
      issue((i) => Object.assign(i, defined(event.payload)));
      return;
    case "IssueRead":
      s.put("issueReads", `${event.payload.memberId}:${id}`, { issueId: id, at: ts }, event.payload.memberId);
      return;
    case "IssueRanked":
      issue((i) => {
        i.rank = event.payload.rank;
      });
      return;
    case "IssueMoved":
      issue((i) => {
        i.stageId = event.payload.to;
        i.autoMove = event.payload.auto ? { from: event.payload.from, to: event.payload.to, reason: event.payload.auto, at: ts } : null;
      });
      return;
    case "LabelAdded":
      issue((i) => {
        if (!i.labelIds.includes(event.payload.labelId)) i.labelIds.push(event.payload.labelId);
      });
      return;
    case "LabelRemoved":
      issue((i) => (i.labelIds = i.labelIds.filter((l) => l !== event.payload.labelId)));
      return;
    case "AssigneeAdded":
      issue((i) => {
        const a = event.payload.assignee;
        if (!i.assignees.some((x) => x.kind === a.kind && x.id === a.id)) i.assignees.push(a);
      });
      return;
    case "AssigneeRemoved":
      issue((i) => (i.assignees = i.assignees.filter((x) => !(x.kind === event.payload.assignee.kind && x.id === event.payload.assignee.id))));
      return;
    case "CommentAdded":
      prepared(db, "INSERT INTO comments (seq, issue_id, author, body, ts) VALUES (?, ?, ?, ?, ?)").run(seq, id, actor, event.payload.body, ts);
      issue(() => undefined);
      return;
    case "CommentEdited":
      prepared(db, "UPDATE comments SET body = ?, edited_at = ? WHERE seq = ? AND issue_id = ?").run(event.payload.body, ts, event.payload.seq, id);
      return;
    case "CommentDeleted":
      prepared(db, "DELETE FROM comments WHERE seq = ? AND issue_id = ?").run(event.payload.seq, id);
      return;
    case "CommentReacted": {
      const row = prepared(db, "SELECT reactions FROM comments WHERE seq = ? AND issue_id = ?").get(event.payload.seq, id) as { reactions: string } | undefined;
      if (!row) return;
      const reactions = JSON.parse(row.reactions) as Record<string, string[]>;
      const who = new Set(reactions[event.payload.reaction] ?? []);
      if (event.payload.on) who.add(actor);
      else who.delete(actor);
      if (who.size) reactions[event.payload.reaction] = [...who];
      else delete reactions[event.payload.reaction];
      prepared(db, "UPDATE comments SET reactions = ? WHERE seq = ?").run(JSON.stringify(reactions), event.payload.seq);
      return;
    }
    case "LinkAdded":
      issue((i) => {
        if (!i.links.some((l) => l.kind === event.payload.link.kind && l.ref === event.payload.link.ref)) i.links.push(event.payload.link);
      });
      return;
    case "LinkRemoved":
      issue((i) => (i.links = i.links.filter((l) => l.id !== event.payload.linkId)));
      return;
    case "BranchCreated":
      issue((i) => {
        i.branch = event.payload.branch;
        i.worktreePath = event.payload.worktreePath;
      });
      return;
    case "IssueDeleted":
      s.delete("issues", id);
      prepared(db, "DELETE FROM comments WHERE issue_id = ?").run(id);
      return;

    case "ProjectAdded":
      s.put("projects", id, { id, ...event.payload, createdAt: ts } satisfies Project);
      return;
    case "ProjectUpdated":
      doc<Project>("projects", (p) => Object.assign(p, defined(event.payload)));
      return;
    case "ProjectRemoved":
      s.delete("projects", id);
      return;
    case "ProjectPersonalScriptsSet":
      doc<Project>("projects", (p) => {
        const { memberId, ...patch } = event.payload;
        const personal = (p.personal ??= {});
        personal[memberId] = { ...(personal[memberId] ?? { setupScript: null, commands: [] }), ...defined(patch) };
      });
      return;

    case "AgentCreated":
      // Agents from before ownership existed belong to the owner and stay visible to the team.
      s.put("agents", id, { id, ownerId: "me", visibility: "public", provider: "claude-code", ...event.payload, createdAt: ts, updatedAt: ts } satisfies Agent);
      return;
    case "AgentUpdated":
      doc<Agent>("agents", (a) => Object.assign(a, defined(event.payload), { updatedAt: ts }));
      return;
    case "AgentEnabled":
    case "AgentDisabled":
      doc<Agent>("agents", (a) => Object.assign(a, { enabled: event.type === "AgentEnabled", updatedAt: ts }));
      return;
    case "AgentDeleted":
      s.delete("agents", id);
      return;

    case "DocCreated":
      // Defaults keep docs created by older versions of Cadence readable.
      s.put(
        "docs",
        id,
        {
          id,
          ...event.payload,
          icon: event.payload.icon ?? null,
          kind: event.payload.kind ?? "markdown",
          assetId: event.payload.assetId ?? null,
          position: event.payload.position ?? 0,
          version: 1,
          createdBy: actor,
          updatedBy: actor,
          createdAt: ts,
          updatedAt: ts,
        } satisfies Doc,
        event.payload.issueId,
        ts,
      );
      return;
    case "DocUpdated":
      doc<Doc>(
        "docs",
        (d) => {
          const p = defined(event.payload);
          const contentChanged = (p.title !== undefined && p.title !== d.title) || (p.body !== undefined && p.body !== d.body) || (p.icon !== undefined && p.icon !== d.icon);
          Object.assign(d, p, { updatedAt: ts, updatedBy: actor });
          if (contentChanged) d.version += 1;
        },
        (d) => d.issueId,
      );
      return;
    case "DocMoved":
      doc<Doc>("docs", (d) => Object.assign(d, event.payload, { updatedAt: ts }), (d) => d.issueId);
      return;
    case "DocDeleted":
      s.delete("docs", id);
      return;
    case "AssetAdded":
      s.put("assets", id, { id, ...event.payload, createdAt: ts } satisfies Asset);
      return;

    case "SettingsChanged":
      s.put("settings", "global", { ...readSettings(s), ...event.payload });
      return;
    default:
      projectChat(db, s, event, seq, ts, actor);
      projectCanvas(s, event, ts, actor);
  }
}

