import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { AttemptLimiter, identify, identityOf, readCookie, SESSION_COOKIE, type AuthOptions } from "../auth-middleware";
import { ValidationError } from "../../core/errors";
import { BUILTIN_SKILLS } from "../../skills/builtin";

const MAX_AGE_S = 30 * 86_400;

function setSession(req: Request, res: Response, token: string | null, cookie = SESSION_COOKIE) {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", token ? `${cookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure}` : `${cookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

const Credentials = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) });
const Join = z.object({ name: z.string().trim().min(1).max(60), email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) });

/** Sign-in endpoints that work without a session (mounted before authentication). */
export function publicAuthRoutes(c: Container, o: AuthOptions): Router {
  const r = Router();
  const limiter = new AttemptLimiter();
  const limit = (req: Request) => {
    if (!limiter.allow(req.socket.remoteAddress ?? "?")) throw new ValidationError("Too many attempts; wait a few minutes");
  };

  r.get("/me", (req, res) => {
    const who = identify(req, c.auth, o);
    res.json({ signedIn: Boolean(who), member: who ? c.q.member(who.memberId) : null, role: who?.role ?? null, team: c.auth.hasTeam() });
  });

  r.post("/login", async (req, res) => {
    limit(req);
    const input = Credentials.parse(req.body);
    const { member, token } = await c.auth.login(input.email, input.password);
    setSession(req, res, token, o.cookie);
    res.json({ member });
  });

  r.post("/logout", (req, res) => {
    const token = readCookie(req, o.cookie ?? SESSION_COOKIE);
    if (token) c.auth.logout(token);
    setSession(req, res, null, o.cookie);
    res.json({ ok: true });
  });

  r.get("/invite/:token", (req, res) => {
    const invite = c.auth.peekInvite(req.params.token);
    res.json(invite ? { valid: true, role: invite.role, expiresAt: invite.expiresAt } : { valid: false });
  });

  r.post("/invite/:token", async (req, res) => {
    limit(req);
    const { member, token } = await c.auth.acceptInvite(req.params.token, Join.parse(req.body));
    setSession(req, res, token, o.cookie);
    res.status(201).json({ member });
  });

  r.post("/request-access", (req, res) => {
    limit(req);
    const input = z.object({ name: z.string().trim().min(1).max(60), email: z.string().trim().min(3).max(200), message: z.string().max(500).default("") }).parse(req.body);
    c.auth.requestAccess(input);
    res.status(202).json({ ok: true });
  });

  return r;
}

const RoleInput = z.enum(["admin", "member"]);

/** The accept-invite link, on the address the person inviting is using. */
function inviteLink(req: Request, token: string, orgId: string): string {
  const origin = typeof req.headers.origin === "string" && /^https?:\/\//.test(req.headers.origin) ? req.headers.origin : `${req.protocol}://${req.headers.host}`;
  return `${origin}/#/invite/${token}${orgId === "default" ? "" : `?org=${encodeURIComponent(orgId)}`}`;
}

/** Members, invites, and access requests (signed in). */
export function memberRoutes(c: Container): Router {
  const r = Router();

  r.get("/", (_req, res) => {
    res.json(c.q.members());
  });

  r.patch("/:id", (req, res) => {
    const patch = z.object({ name: z.string().trim().min(1).max(60), email: z.string().trim().max(200), role: RoleInput }).partial().parse(req.body);
    res.json(c.auth.update(req.params.id, patch, identityOf(res)));
  });

  r.delete("/:id", (req, res) => {
    c.auth.remove(req.params.id, identityOf(res));
    res.json({ ok: true });
  });

  /** Sets your own password (the owner sets one to sign in from other machines). */
  r.put("/me/password", async (req, res) => {
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    await c.auth.setPassword(identityOf(res).memberId, password);
    res.json({ ok: true });
  });

  r.put("/me/onboarding", (req, res) => {
    const input = z.object({ jobRole: z.enum(["engineer", "designer", "product", "founder", "other"]).optional(), done: z.boolean().optional(), hideGettingStarted: z.boolean().optional() }).parse(req.body);
    res.json(c.auth.setOnboarding(identityOf(res).memberId, input));
  });

  r.put("/me/preferences", (req, res) => {
    const { systemPrompt } = z.object({ systemPrompt: z.string().max(20_000) }).parse(req.body);
    res.json(c.auth.setPreferences(identityOf(res).memberId, { systemPrompt }));
  });

  /** Your own skills. */
  /** Workflows that ship with Cadence, for the composer's slash commands. */
  r.get("/me/skills/builtin", (_req, res) => {
    res.json(BUILTIN_SKILLS.map(({ name, title, description, argumentHint }) => ({ name, title, description, argumentHint })));
  });

  r.get("/me/skills", (_req, res) => {
    res.json(c.skills.list(identityOf(res).memberId));
  });

  r.put("/me/skills", (req, res) => {
    const input = z.object({ name: z.string().min(1).max(49), description: z.string().max(300).default(""), body: z.string().min(1).max(50_000) }).parse(req.body);
    res.json(c.skills.save(identityOf(res).memberId, input, identityOf(res).actor));
  });

  r.post("/me/skills/:id/duplicate", (req, res) => {
    res.status(201).json(c.skills.duplicate(identityOf(res).memberId, req.params.id, identityOf(res).actor));
  });

  r.delete("/me/skills/:id", (req, res) => {
    c.skills.delete(identityOf(res).memberId, req.params.id, identityOf(res).actor);
    res.json({ ok: true });
  });

  r.get("/invites", (_req, res) => {
    res.json(c.auth.invites());
  });

  /** An invite link; with `email`, it is also sent there. */
  r.post("/invites", async (req, res) => {
    const { role, email } = z.object({ role: RoleInput.default("member"), email: z.string().trim().email().max(200).optional() }).parse(req.body ?? {});
    if (email && !c.mailer.status().configured) throw new ValidationError("Set up email below before sending invites by email");
    const created = c.auth.createInvite(role, identityOf(res), email);
    if (email) {
      const org = c.org();
      try {
        await c.mailer.send(c.mailer.inviteMail({ to: email, orgName: org.name, inviter: c.q.member(identityOf(res).memberId)?.name ?? "Someone", role, link: inviteLink(req, created.token, org.id), expiresAt: created.invite.expiresAt }));
      } catch (err) {
        // A link nobody received is no use; take it back.
        c.auth.revokeInvite(created.invite.id);
        throw err;
      }
    }
    res.status(201).json({ ...created, emailed: Boolean(email) });
  });

  r.get("/email", (_req, res) => {
    if (identityOf(res).role === "member") throw new ValidationError("Only admins can see email settings");
    res.json(c.mailer.status());
  });

  r.put("/email", async (req, res) => {
    if (identityOf(res).role === "member") throw new ValidationError("Only admins can change email settings");
    const input = z
      .object({ host: z.string().trim().min(1).max(200), port: z.number().int().min(1).max(65535), secure: z.boolean(), user: z.string().max(200), pass: z.string().max(500), from: z.string().trim().min(3).max(200) })
      .nullable()
      .parse(req.body);
    res.json(await c.mailer.save(input));
  });

  r.delete("/invites/:id", (req, res) => {
    if (identityOf(res).role === "member") throw new ValidationError("Only admins can revoke invites");
    c.auth.revokeInvite(req.params.id);
    res.json({ ok: true });
  });

  r.get("/requests", (_req, res) => {
    res.json(identityOf(res).role === "member" ? [] : c.auth.requests());
  });

  /** Approving makes an invite for the requester; with email set up, it is sent to them. */
  r.post("/requests/:id/approve", async (req, res) => {
    const { role } = z.object({ role: RoleInput.default("member") }).parse(req.body ?? {});
    const approved = c.auth.approveRequest(req.params.id, role, identityOf(res));
    let emailed = false;
    if (c.mailer.status().configured) {
      const org = c.org();
      await c.mailer.send(c.mailer.inviteMail({ to: approved.request.email, orgName: org.name, inviter: c.q.member(identityOf(res).memberId)?.name ?? "Someone", role, link: inviteLink(req, approved.token, org.id), expiresAt: approved.invite.expiresAt }));
      emailed = true;
    }
    res.json({ ...approved, emailed });
  });

  r.delete("/requests/:id", (req, res) => {
    if (identityOf(res).role === "member") throw new ValidationError("Only admins can answer requests");
    c.auth.denyRequest(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
