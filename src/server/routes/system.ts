import { Router } from "express";
import type { Container } from "../container";
import { SettingsPatch } from "../schemas";
import { identityOf } from "../auth-middleware";
import type { Snapshot } from "../../core/types";
import { AGENT_TEMPLATES } from "../../agents/templates";
import { monthOf } from "../../usage/service";
import { agentAccess, agentForViewer } from "../../core/agent-commands";
import type { RequestIdentity } from "../../auth/context";
import type { Queries } from "../../core/queries";
import type { StoredEvent } from "../../core/types";
import { projectForViewer } from "../../projects/scripts";
import { commentInbox } from "../../canvas/inbox";
import { z } from "zod";
import { NotFoundError } from "../../core/errors";

/**
 * Clients only use pushed events as a cue to refresh, so anything private to
 * someone else (a private agent's instructions, a person's skills or own
 * instructions) goes out with its payload emptied.
 */
export function redactEvent(event: StoredEvent, viewer: RequestIdentity, q: Queries): StoredEvent {
  const hide = () => ({ ...event, payload: {} }) as StoredEvent;
  if (event.aggregate === "agent") {
    const agent = q.agent(event.aggregateId);
    if (!agent || !agentAccess(agent, viewer).manage) return hide();
  }
  if (event.aggregate === "skill") {
    // Deletions carry no owner; an empty payload is still a cue to refresh.
    if ((event.payload as { ownerId?: string }).ownerId !== viewer.memberId) return hide();
  }
  if (event.type === "ProjectPersonalScriptsSet" && (event.payload as { memberId?: string }).memberId !== viewer.memberId) return hide();
  if (event.type === "MemberUpdated" && event.aggregateId !== viewer.memberId && "systemPrompt" in (event.payload as object)) {
    const { systemPrompt: _p, ...rest } = event.payload as Record<string, unknown>;
    return { ...event, payload: rest } as StoredEvent;
  }
  return event;
}

const CONTEXT_PREVIEW = 280;
const MAX_SSE_BACKLOG = 4 * 1024 * 1024;
const REPLAY_LIMIT = 500;

// Every connected client gets the same bytes for an event nobody needs hidden, so each is serialized once.
const domainText = new WeakMap<StoredEvent, string>();
function serialized(event: StoredEvent): string {
  let text = domainText.get(event);
  if (text === undefined) domainText.set(event, (text = `id: ${event.seq}\nevent: domain\ndata: ${JSON.stringify(event)}\n\n`));
  return text;
}
const busText = new WeakMap<object, string>();
function serializedBus(e: { type: string }): string {
  let text = busText.get(e);
  if (text === undefined) busText.set(e, (text = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
  return text;
}

export function systemRoutes(c: Container): Router {
  const r = Router();

  r.get("/health", (_req, res) => {
    res.json({ ok: true, activeRuns: c.queue.activeCount, scheduledJobs: c.scheduler.jobCount, runtime: c.defaultRuntime().name });
  });

  r.get("/snapshot", async (req, res) => {
    const source = await c.github.source();
    const snapshot: Snapshot = {
      stages: c.q.stages(),
      labels: c.q.labels(),
      issues: c.q.issues(),
      agents: c.q.agents().map((a) => agentForViewer(a, identityOf(res))),
      // A run's trigger context can be long; lists only need a preview, and GET /api/runs/:id has all of it.
      runs: c.q.runs().map((r) => (r.context.length > CONTEXT_PREVIEW ? { ...r, context: `${r.context.slice(0, CONTEXT_PREVIEW)}...` } : r)),
      projects: c.q.projects().map((p) => projectForViewer(p, identityOf(res).memberId)),
      docs: c.q.docs(),
      workspaces: c.q.workspaces(),
      // A chat's command list and descriptions run to kilobytes and only its own composer uses them;
      // GET /api/chats/:id carries them.
      chats: c.q.chats().map(({ commandHints: _h, ...chat }) => ({ ...chat, slashCommands: [] })),
      pullRequests: c.q.pullRequests(),
      // A person's own instructions are private to them.
      members: c.q.members().map((m) => (m.id === identityOf(res).memberId ? m : { ...m, systemPrompt: undefined })),
      viewer: { memberId: identityOf(res).memberId, role: identityOf(res).role },
      github: { connected: source !== null, source },
      pendingInteractions: c.q.pendingInteractions(),
      issueViews: c.q.issueViews().filter((v) => v.shared || v.ownerId === identityOf(res).memberId),
      issueReads: c.q.issueReads(identityOf(res).memberId),
      settings: c.q.settings(),
      providers: c.providers.summaries(),
      runtimeReady: true,
    };
    res.json(snapshot);
  });

  /** The viewer's open canvas views report their selection, for agents' selection context. */
  r.put("/design-context/:id", (req, res) => {
    const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
    const input = z
      .object({
        workspaceId: z.string().max(100),
        path: z.string().max(500),
        storyId: z.string().max(100).nullable(),
        element: z
          .object({ loc: z.string().max(600), tag: z.string().max(60), className: z.string().max(2000), text: z.string().max(2000).nullable(), rect: Rect, ancestors: z.array(z.object({ loc: z.string().max(600), tag: z.string().max(60), className: z.string().max(2000) })).max(8), count: z.number() })
          .nullable(),
      })
      .parse(req.body);
    if (!c.q.workspace(input.workspaceId)) throw new NotFoundError("Workspace not found");
    res.json(c.designContext.report(identityOf(res).memberId, { id: req.params.id.slice(0, 64), ...input }));
  });

  r.delete("/design-context/:id", (req, res) => {
    c.designContext.close(identityOf(res).memberId, req.params.id);
    res.json({ ok: true });
  });

  /** Canvas comment threads with something new for the viewer (mentions and replies). */
  r.get("/inbox", (_req, res) => {
    res.json(commentInbox(c.q, identityOf(res).memberId));
  });

  /** Browser heartbeat: what this tab is looking at (null when it leaves). */
  r.post("/presence", (req, res) => {
    const body = (req.body ?? {}) as { tab?: unknown; place?: unknown };
    const tab = typeof body.tab === "string" ? body.tab.slice(0, 40) : "default";
    const place = typeof body.place === "string" && body.place.length <= 600 ? body.place : null;
    c.presence.beat(identityOf(res).memberId, tab, place);
    res.json({ viewers: c.presence.list() });
  });

  /** Spend for a month (?month=YYYY-MM, default this one), against the budgets. Owner and admins. */
  r.get("/usage", (req, res) => {
    if (identityOf(res).role === "member") return void res.status(403).json({ error: "Only the owner and admins can see usage" });
    res.json(c.usage.report(typeof req.query.month === "string" ? req.query.month : monthOf()));
  });

  r.get("/templates", (_req, res) => {
    res.json(AGENT_TEMPLATES);
  });

  r.patch("/settings", (req, res) => {
    if (identityOf(res).role === "member") return void res.status(403).json({ error: "Only admins can change settings" });
    res.json(c.agents.updateSettings(SettingsPatch.parse(req.body)));
  });

  // Server-sent events: every appended domain event is pushed to the client,
  // which uses them to refresh its view.
  r.get("/events", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const viewer = identityOf(res);
    // A client that stops reading (asleep, on a stalled tunnel) is let go before its backlog grows without bound;
    // its EventSource reconnects and catches up from Last-Event-ID.
    const send = (text: string) => {
      if (res.writableLength > MAX_SSE_BACKLOG) return void res.destroy();
      res.write(text);
    };
    const domain = (event: StoredEvent) => {
      const shown = redactEvent(event, viewer, c.q);
      send(shown === event ? serialized(event) : `id: ${event.seq}\nevent: domain\ndata: ${JSON.stringify(shown)}\n\n`);
    };
    // Reconnecting: replay what was missed, or ask for a full reload when it is too much.
    const last = Number(req.headers["last-event-id"]);
    if (Number.isInteger(last) && last > 0) {
      const missed = c.store.after(last, REPLAY_LIMIT + 1);
      if (missed.length > REPLAY_LIMIT) send(`id: ${missed.at(-1)!.seq}\nevent: resync\ndata: {}\n\n`);
      else missed.forEach(domain);
    }
    const unsubscribe = c.store.subscribe(domain);
    // Where this client is now, so a reconnect can catch up even if no event came before the drop
    // (the browser keeps the id of the last event and sends it back as Last-Event-ID).
    // Reconnect after 2 s rather than the browser's default.
    if (!(Number.isInteger(last) && last > 0)) send(`retry: 2000\nid: ${c.store.lastSeq()}\n\n`);
    // Streamed assistant text: not persisted, only forwarded while it is typed.
    const unsubscribeBus = c.bus.subscribe((e) => send(serializedBus(e)));
    const ping = setInterval(() => send(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
      unsubscribeBus();
    });
  });

  return r;
}
