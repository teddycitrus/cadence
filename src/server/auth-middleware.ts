import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import type { RequestIdentity } from "../auth/context";
import { withIdentity } from "../auth/context";
import type { AuthService } from "../auth/service";

export const SESSION_COOKIE = "cadence_session";
const OWNER: RequestIdentity = { actor: "user", memberId: "me", role: "owner" };

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function bearerMatches(expected: string, header: string | undefined): boolean {
  const given = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Whether a request was addressed to this machine by a loopback name (not a public address that tunnels here). */
export function addressedLocally(req: IncomingMessage): boolean {
  return LOOPBACK_HOST.test(req.headers.host ?? "");
}

/**
 * Requests from this machine act as the owner, unless they came through a
 * proxy or tunnel (which would make every visitor look local) or local trust
 * is off. A tunnel connects from this machine too, so the request must also be
 * addressed to a loopback name and carry no proxy headers.
 */
export function isLocal(req: IncomingMessage, trustLocal: boolean): boolean {
  return (
    trustLocal &&
    LOOPBACK.has(req.socket.remoteAddress ?? "") &&
    addressedLocally(req) &&
    !req.headers["x-forwarded-for"] &&
    !req.headers.forwarded &&
    !req.headers["cf-connecting-ip"]
  );
}

export interface AuthOptions {
  apiToken: string | null;
  trustLocal: boolean;
  /** The session cookie's name; each organization has its own, so people can be signed in to several. */
  cookie?: string;
}

/** Who is making this request, or null when nobody is signed in. */
export function identify(req: IncomingMessage, auth: AuthService, o: AuthOptions): RequestIdentity | null {
  const header = req.headers.authorization;
  if (o.apiToken && header && bearerMatches(o.apiToken, header)) return OWNER;
  const session = auth.identify(readCookie(req, o.cookie ?? SESSION_COOKIE));
  if (session) return session;
  return isLocal(req, o.trustLocal) ? OWNER : null;
}

/** Sets the request's identity (the default actor for every command it runs), or answers 401. */
export function authenticate(auth: AuthService, o: AuthOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    // EventSource cannot send headers, so the stream also accepts ?token=.
    if (o.apiToken && typeof req.query.token === "string" && !req.headers.authorization) req.headers.authorization = `Bearer ${req.query.token}`;
    const who = identify(req, auth, o);
    if (!who) {
      res.status(401).json({ error: "Sign in to Cadence", signIn: true });
      return;
    }
    res.locals.identity = who;
    withIdentity(who, () => next());
  };
}

export const identityOf = (res: Response): RequestIdentity => res.locals.identity as RequestIdentity;

/**
 * Chats, terminals, git, and canvas servers run code on the host machine with
 * the owner's credentials, so members may read them but only the owner and
 * admins can act.
 */
export function hostActions(allowForMembers: (req: Request) => boolean = () => false) {
  return (req: Request, res: Response, next: NextFunction) => {
    const who = identityOf(res);
    if (who.role === "member" && req.method !== "GET" && !allowForMembers(req)) {
      res.status(403).json({ error: "Only the owner and admins can do this, since it runs on the host machine." });
      return;
    }
    next();
  };
}

/** Owner and admins only, for reads too (machine configuration). */
export function adminOnly(_req: Request, res: Response, next: NextFunction): void {
  if (identityOf(res).role === "member") {
    res.status(403).json({ error: "Only the owner and admins can see this." });
    return;
  }
  next();
}

/** A small per-address limiter for sign-in attempts. */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max = 10,
    private windowMs = 10 * 60_000,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    return recent.length <= this.max;
  }
}
