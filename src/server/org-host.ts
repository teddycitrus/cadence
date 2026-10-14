import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Express, NextFunction, Request, Response } from "express";
import { ValidationError } from "../core/errors";
import { DEFAULT_ORG, type Org, type OrgRegistry } from "../orgs/registry";
import { createApp } from "./app";
import { readCookie, SESSION_COOKIE } from "./auth-middleware";
import type { Container } from "./container";
import { refuseUpgrade } from "./refuse-upgrade";

export const ORG_HEADER = "x-cadence-org";
export const ORG_COOKIE = "cadence_org";

export interface OrgEntry {
  org: Org;
  container: Container;
  app: Express;
  /** Stands in for the HTTP server for this org's WebSocket handlers. */
  upgrades: Server;
  cookie: string;
}

export interface OrgHostOptions {
  apiToken: string | null;
  trustLocal: boolean;
  /** Builds an org's container from its folder. */
  makeContainer: (org: Org) => Container;
  /** Wires an org's WebSocket handlers (docs, terminals, browser) onto `entry.upgrades`. */
  attachSockets?: (entry: OrgEntry) => void;
}

/** The session cookie for an org: the first keeps the original name, so existing sign-ins survive. */
export const sessionCookie = (orgId: string) => (orgId === DEFAULT_ORG ? SESSION_COOKIE : `${SESSION_COOKIE}_${orgId.replace(/-/g, "")}`);

/** Which org a request is for: the header, ?org=, or the cookie the web app sets; else the first org. */
export function orgOf(req: IncomingMessage): string {
  const header = req.headers[ORG_HEADER];
  if (typeof header === "string" && header) return header;
  const q = new URL(req.url ?? "/", "http://localhost").searchParams.get("org");
  if (q) return q;
  return readCookie(req, ORG_COOKIE) || DEFAULT_ORG;
}

/**
 * Runs every organization side by side: each has its own container (data,
 * members, integrations, agents) and its own Express app; requests and
 * WebSocket upgrades are handed to the org they name.
 */
export class OrgHost {
  private entries = new Map<string, OrgEntry>();
  private baseUrl: string | null = null;

  constructor(
    readonly registry: OrgRegistry,
    private o: OrgHostOptions,
  ) {}

  /** Opens and starts every registered org. */
  openAll(): void {
    for (const org of this.registry.list()) this.open(org);
  }

  private open(org: Org): OrgEntry {
    const existing = this.entries.get(org.id);
    if (existing) return existing;
    const container = this.o.makeContainer(org);
    const cookie = sessionCookie(org.id);
    const app = createApp(container, { apiToken: this.o.apiToken, staticDir: null, trustLocal: this.o.trustLocal, cookie });
    const entry: OrgEntry = { org, container, app, upgrades: new EventEmitter() as unknown as Server, cookie };
    this.entries.set(org.id, entry);
    this.o.attachSockets?.(entry);
    if (this.baseUrl) this.point(entry);
    container.start();
    return entry;
  }

  /** Other harnesses reach this org's board tools over loopback, naming the org. */
  private point(entry: OrgEntry): void {
    entry.container.toolBridge.baseUrl = this.baseUrl;
    entry.container.toolBridge.query = `?org=${encodeURIComponent(entry.org.id)}`;
  }

  /** Once the server listens: where the orgs' MCP endpoints are. */
  listening(baseUrl: string): void {
    this.baseUrl = baseUrl;
    for (const e of this.entries.values()) this.point(e);
  }

  get(orgId: string): OrgEntry | null {
    const e = this.entries.get(orgId);
    if (e) {
      // Renames show up without a restart.
      e.org = this.registry.get(orgId) ?? e.org;
      return e;
    }
    return null;
  }

  all(): OrgEntry[] {
    return this.registry
      .list()
      .map((o) => this.get(o.id))
      .filter((e): e is OrgEntry => e !== null);
  }

  create(name: string, slug?: string): OrgEntry {
    return this.open(this.registry.create(name, slug));
  }

  /** Stops an org and moves its folder aside. The first org cannot be removed. */
  remove(orgId: string): void {
    this.registry.getOrThrow(orgId);
    if (orgId === DEFAULT_ORG) throw new ValidationError("The first organization holds this Cadence's own data and cannot be deleted");
    const e = this.entries.get(orgId);
    if (e) {
      e.container.stop();
      e.container.db.close();
      this.entries.delete(orgId);
    }
    this.registry.remove(orgId);
  }

  /** Express middleware: hands the request to its org's app. */
  /**
   * The org a request is for. An org named only by the cookie falls back to
   * the default when unknown: the cookie is shared by every port on the host,
   * so a machine opened through a relay can overwrite it.
   */
  entryFor(req: IncomingMessage): OrgEntry | null | undefined {
    const id = orgOf(req);
    const explicit = Boolean(req.headers[ORG_HEADER]) || new URL(req.url ?? "/", "http://localhost").searchParams.has("org");
    return this.get(id) ?? (explicit ? undefined : this.get(DEFAULT_ORG));
  }

  dispatch(): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      const e = this.entryFor(req);
      if (!e) {
        res.status(404).json({ error: "That organization does not exist (or was deleted)", orgMissing: true });
        return;
      }
      e.app(req, res, next);
    };
  }

  /** Hands WebSocket upgrades to the org they name. */
  attachUpgrades(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const e = this.entryFor(req);
      if (!e) {
        refuseUpgrade(socket, "404 Not Found");
        return;
      }
      e.upgrades.emit("upgrade", req, socket, head);
    });
  }

  stopAll(): void {
    for (const e of this.entries.values()) {
      e.container.stop();
      e.container.db.close();
    }
    this.entries.clear();
  }
}
