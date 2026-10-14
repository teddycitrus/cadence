import { randomBytes } from "node:crypto";
import { NotFoundError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Actor, ShareLink } from "../core/types";
import type { CanvasService } from "../canvas/service";

export type SharedView =
  | { kind: "doc"; title: string; body: string; updatedAt: string }
  | {
      kind: "issue";
      key: string;
      title: string;
      body: string;
      stage: string;
      priority: string;
      type: string;
      comments: { author: string; body: string; at: string }[];
      links: { kind: string; title: string; ref: string }[];
    }
  | { kind: "canvas"; title: string; background: string; storyboards: { id: string; name: string; width: number; height: number }[] };

const ASSET_REF = /\/api\/assets\/([0-9a-f-]{36})/g;

/**
 * Read-only public links. The link id is a long random token; revoking it
 * stops the page at once. Only what the shared thing shows is reachable
 * through it (a shared doc's own images, a shared canvas's frames).
 */
export class ShareService {
  constructor(
    private store: EventStore,
    private q: Queries,
    private canvases: CanvasService,
  ) {}

  create(kind: ShareLink["kind"], ref: string, actor: Actor): ShareLink {
    const existing = this.q.shares().find((s) => s.kind === kind && s.ref === ref && !s.revoked);
    if (existing) return existing;
    const title = this.titleOf(kind, ref);
    const id = randomBytes(18).toString("base64url");
    this.store.append({ aggregate: "share", type: "ShareCreated", aggregateId: id, payload: { kind, ref, title } }, actor);
    return this.q.share(id)!;
  }

  revoke(id: string, actor: Actor): void {
    if (!this.q.share(id)) throw new NotFoundError("Share link not found");
    this.store.append({ aggregate: "share", type: "ShareRevoked", aggregateId: id, payload: {} }, actor);
  }

  forRef(kind: ShareLink["kind"], ref: string): ShareLink | null {
    return this.q.shares().find((s) => s.kind === kind && s.ref === ref && !s.revoked) ?? null;
  }

  private titleOf(kind: ShareLink["kind"], ref: string): string {
    if (kind === "doc") {
      const d = this.q.doc(ref);
      if (!d) throw new NotFoundError("Doc not found");
      return d.title;
    }
    if (kind === "issue") {
      const i = this.q.issue(ref);
      if (!i) throw new NotFoundError("Issue not found");
      return `${i.key} ${i.title}`;
    }
    const [ws, path] = splitCanvas(ref);
    return this.canvases.read(ws, path).name;
  }

  /** The live link, or not found (never revealing whether it once existed). */
  link(id: string): ShareLink {
    const s = this.q.share(id);
    if (!s || s.revoked) throw new NotFoundError("This link is not available");
    return s;
  }

  view(id: string): SharedView {
    const s = this.link(id);
    if (s.kind === "doc") {
      const d = this.q.doc(s.ref);
      if (!d) throw new NotFoundError("This link is not available");
      return { kind: "doc", title: d.title, body: d.body.replace(ASSET_REF, `/api/share/${id}/assets/$1`), updatedAt: d.updatedAt };
    }
    if (s.kind === "issue") {
      const i = this.q.issue(s.ref);
      if (!i) throw new NotFoundError("This link is not available");
      const name = (actor: string) => (actor === "user" ? (this.q.member("me")?.name ?? "Owner") : actor.startsWith("member:") ? (this.q.member(actor.slice(7))?.name ?? "Former member") : actor.startsWith("agent:") ? (this.q.agent(actor.slice(6))?.name ?? "Agent") : "Cadence");
      return {
        kind: "issue",
        key: i.key,
        title: i.title,
        body: i.body,
        stage: this.q.stage(i.stageId)?.name ?? "",
        priority: i.priority,
        type: i.type,
        comments: this.q.comments(i.id).map((c) => ({ author: name(c.author), body: c.body, at: c.ts })),
        // Doc links point inside Cadence, which a visitor cannot open.
        links: i.links.filter((l) => l.kind !== "doc").map((l) => ({ kind: l.kind, title: l.title, ref: l.ref })),
      };
    }
    const [ws, path] = splitCanvas(s.ref);
    const c = this.canvases.read(ws, path);
    return { kind: "canvas", title: c.name, background: c.background, storyboards: c.storyboards.map((st) => ({ id: st.id, name: st.name, width: st.frame.width, height: st.frame.height })) };
  }

  /** An image a shared doc shows: only assets its body references. */
  docAsset(id: string, assetId: string): string {
    const s = this.link(id);
    const d = s.kind === "doc" ? this.q.doc(s.ref) : null;
    if (!d || !d.body.includes(`/api/assets/${assetId}`)) throw new NotFoundError("Not found");
    return assetId;
  }

  canvasStory(id: string, storyId: string): { workspaceId: string; path: string; storyId: string } {
    const s = this.link(id);
    if (s.kind !== "canvas") throw new NotFoundError("Not found");
    const [workspaceId, path] = splitCanvas(s.ref);
    if (!this.canvases.read(workspaceId, path).storyboards.some((st) => st.id === storyId)) throw new NotFoundError("Not found");
    return { workspaceId, path, storyId };
  }
}

export function splitCanvas(ref: string): [string, string] {
  const cut = ref.indexOf("|");
  if (cut < 1) throw new NotFoundError("Canvas not found");
  return [ref.slice(0, cut), ref.slice(cut + 1)];
}
