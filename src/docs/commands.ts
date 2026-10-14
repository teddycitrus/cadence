import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { DomainEvent } from "../core/events";
import type { IssueCommands } from "../core/issue-commands";
import type { Queries } from "../core/queries";
import type { Actor, Doc, DocKind, DocVersion } from "../core/types";
import { currentActor } from "../auth/context";

/** A save based on an out-of-date version; carries the current doc so the client can reconcile. */
export class DocConflictError extends ConflictError {
  constructor(readonly current: Doc) {
    super(`"${current.title}" changed since you opened it (now version ${current.version})`);
  }
}

export interface NewDoc {
  title: string;
  body?: string;
  icon?: string | null;
  parentId?: string | null;
  issueId?: string | null;
  kind?: DocKind;
  assetId?: string | null;
}

/** Write side for docs: a tree of pages with versioned markdown bodies. */
export class DocCommands {
  constructor(
    private store: EventStore,
    private q: Queries,
    private issues: IssueCommands,
    private newId: () => string = randomUUID,
  ) {}

  docOrThrow(id: string): Doc {
    const doc = this.q.doc(id);
    if (!doc) throw new NotFoundError(`Doc ${id} not found`);
    return doc;
  }

  private children(parentId: string | null): Doc[] {
    return this.q
      .docs()
      .filter((d) => d.parentId === parentId)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  }

  create(input: NewDoc, actor: Actor = currentActor()): Doc {
    if (input.parentId) this.docOrThrow(input.parentId);
    const issueId = input.issueId ? this.issues.issueOrThrow(input.issueId).id : null;
    const id = this.newId();
    this.store.append(
      {
        aggregate: "doc",
        type: "DocCreated",
        aggregateId: id,
        payload: {
          title: input.title,
          body: input.body ?? "",
          icon: input.icon ?? null,
          kind: input.kind ?? "markdown",
          assetId: input.assetId ?? null,
          parentId: input.parentId ?? null,
          issueId,
          position: this.children(input.parentId ?? null).length,
        },
      },
      actor,
    );
    if (issueId) this.issues.addLink(issueId, { kind: "doc", ref: id, title: input.title }, actor);
    return this.docOrThrow(id);
  }

  /**
   * Updates a doc. With `baseVersion`, the save is rejected if someone else
   * (a person or an agent) changed the doc since that version.
   */
  update(id: string, patch: { title?: string; body?: string; icon?: string | null; issueId?: string | null }, actor: Actor = currentActor(), baseVersion?: number): Doc {
    const doc = this.docOrThrow(id);
    if (baseVersion !== undefined && baseVersion !== doc.version) throw new DocConflictError(doc);
    if (doc.kind === "pdf" && patch.body !== undefined) throw new ValidationError("PDF docs have no editable body");
    const events: DomainEvent[] = [{ aggregate: "doc", type: "DocUpdated", aggregateId: id, payload: patch }];
    this.store.append(events, actor);
    if (patch.issueId !== undefined && patch.issueId !== doc.issueId) this.relink(doc, patch.issueId, actor);
    return this.docOrThrow(id);
  }

  private relink(doc: Doc, issueId: string | null, actor: Actor): void {
    if (doc.issueId) {
      const old = this.q.issue(doc.issueId);
      const link = old?.links.find((l) => l.kind === "doc" && l.ref === doc.id);
      if (old && link) this.issues.removeLink(old.id, link.id, actor);
    }
    if (issueId) this.issues.addLink(issueId, { kind: "doc", ref: doc.id, title: doc.title }, actor);
  }

  /** Replaces one exact, unique passage. Safer than rewriting a doc others may be editing. */
  edit(id: string, oldText: string, newText: string, actor: Actor): Doc {
    const doc = this.docOrThrow(id);
    const count = doc.body.split(oldText).length - 1;
    if (!oldText || count === 0) throw new ValidationError("That passage is not in the doc; read it again with docs_get");
    if (count > 1) throw new ValidationError(`That passage appears ${count} times; include more surrounding text`);
    return this.update(id, { body: doc.body.replace(oldText, () => newText) }, actor);
  }

  /** Moves a doc under a new parent (or to the top level) at a position among its siblings. */
  move(id: string, parentId: string | null, position: number, actor: Actor = currentActor()): void {
    const doc = this.docOrThrow(id);
    for (let p = parentId; p; p = this.docOrThrow(p).parentId) {
      if (p === id) throw new ValidationError("A doc cannot be moved inside itself");
    }
    const siblings = this.children(parentId).filter((d) => d.id !== id);
    const index = Math.max(0, Math.min(position, siblings.length));
    siblings.splice(index, 0, doc);
    const events: DomainEvent[] = siblings
      .map((d, i) => ({ d, i }))
      .filter(({ d, i }) => d.id === id || d.position !== i)
      .map(({ d, i }) => ({ aggregate: "doc", type: "DocMoved", aggregateId: d.id, payload: { parentId, position: i } }));
    this.store.append(events, actor);
  }

  /** Deletes a doc and all its sub-pages. */
  delete(id: string, actor: Actor = currentActor()): void {
    const doc = this.docOrThrow(id);
    const ids: string[] = [];
    const walk = (d: Doc) => {
      for (const child of this.children(d.id)) walk(child);
      ids.push(d.id);
    };
    walk(doc);
    this.store.append(
      ids.map((docId) => ({ aggregate: "doc", type: "DocDeleted", aggregateId: docId, payload: {} })),
      actor,
    );
    if (doc.issueId) this.relink(doc, null, actor);
  }

  /** Every content version of a doc, newest first, rebuilt from its events. */
  history(id: string): DocVersion[] {
    this.docOrThrow(id);
    const versions: DocVersion[] = [];
    let title = "";
    let body = "";
    let icon: string | null = null;
    let version = 0;
    for (const e of this.store.forAggregate("doc", id)) {
      if (e.type === "DocCreated") {
        title = String(e.payload.title);
        body = String(e.payload.body);
        icon = (e.payload.icon as string | null) ?? null;
        version = 1;
        versions.push({ seq: e.seq, version, title, body, actor: e.actor, ts: e.ts });
      } else if (e.type === "DocUpdated") {
        const p = e.payload as { title?: string; body?: string; icon?: string | null };
        const changed = (p.title !== undefined && p.title !== title) || (p.body !== undefined && p.body !== body) || (p.icon !== undefined && p.icon !== icon);
        title = p.title ?? title;
        body = p.body ?? body;
        icon = p.icon !== undefined ? p.icon : icon;
        if (changed) versions.push({ seq: e.seq, version: ++version, title, body, actor: e.actor, ts: e.ts });
      }
    }
    return versions.reverse();
  }

  restore(id: string, version: number, actor: Actor = currentActor()): Doc {
    const target = this.history(id).find((v) => v.version === version);
    if (!target) throw new NotFoundError(`Version ${version} not found`);
    return this.update(id, { title: target.title, body: target.body }, actor);
  }
}
