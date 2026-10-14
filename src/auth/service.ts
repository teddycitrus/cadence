import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Member, Role } from "../core/types";
import type { SecretStore } from "../integrations/secrets";
import { actorForMember, type RequestIdentity } from "./context";
import { checkPasswordStrength, hashPassword, verifyPassword } from "./passwords";

const SESSION_IDLE_MS = 30 * 86_400_000;
const INVITE_MS = 7 * 86_400_000;
const MAX_REQUESTS = 50;
const COLORS = ["#8a5a7a", "#5b8a9c", "#7a9a7a", "#c99f45", "#c27a86", "#c8703e", "#5e9690", "#b6452a"];

interface Session {
  hash: string;
  memberId: string;
  createdAt: string;
  lastSeen: string;
}

export interface Invite {
  id: string;
  role: Exclude<Role, "owner">;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** Who it was emailed to, when it was. */
  email?: string;
  /** Kept only as a hash; the link is shown once. */
  hash: string;
}

export interface AccessRequest {
  id: string;
  name: string;
  email: string;
  message: string;
  createdAt: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Members, sign-in, invites, and access requests. Member records are events
 * (so the board shows names); passwords, sessions, and invite tokens live in
 * the data dir's auth file, hashed, and never in the event log.
 */
export class AuthService {
  constructor(
    private store: EventStore,
    private q: Queries,
    private secrets: SecretStore,
  ) {}

  private read<T>(key: string): T[] {
    const raw = this.secrets.get(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  }

  private write<T>(key: string, list: T[]): void {
    this.secrets.set(key, list.length ? JSON.stringify(list) : null);
  }

  private passwords(): Record<string, string> {
    const raw = this.secrets.get("passwords");
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }

  /** The person running Cadence is always member "me". */
  ensureOwner(): void {
    if (this.q.member("me")) return;
    this.store.append({ aggregate: "member", type: "MemberJoined", aggregateId: "me", payload: { name: "Owner", email: "", role: "owner", color: COLORS[0]! } }, "system");
  }

  memberOrThrow(id: string): Member {
    const m = this.q.member(id);
    if (!m) throw new NotFoundError("Member not found");
    return m;
  }

  /** Whether anyone besides the owner can sign in (team mode). */
  hasTeam(): boolean {
    return this.q.members().some((m) => m.id !== "me") || Boolean(this.passwords().me);
  }

  update(id: string, patch: { name?: string; email?: string; role?: Role }, by: RequestIdentity): Member {
    const m = this.memberOrThrow(id);
    const self = by.memberId === id;
    if (!self && by.role === "member") throw new ConflictError("Only admins can change other members");
    if (patch.role !== undefined) {
      if (by.role === "member") throw new ConflictError("Only admins can change roles");
      if (m.role === "owner" || patch.role === "owner") throw new ConflictError("The owner's role cannot change");
    }
    if (patch.email !== undefined) {
      const email = normEmail(patch.email);
      if (email && !EMAIL.test(email)) throw new ValidationError("That email address does not look right");
      if (email && this.q.members().some((x) => x.id !== id && x.email === email)) throw new ConflictError("Another member uses that email");
      patch.email = email;
    }
    this.store.append({ aggregate: "member", type: "MemberUpdated", aggregateId: id, payload: patch }, by.actor);
    return this.memberOrThrow(id);
  }

  /** A person's own chat preferences. */
  /** Onboarding answers for oneself: what they do, and that they are done. */
  setOnboarding(memberId: string, input: { jobRole?: string; done?: boolean; hideGettingStarted?: boolean }): Member {
    this.memberOrThrow(memberId);
    const payload = {
      ...(input.jobRole !== undefined ? { jobRole: input.jobRole.slice(0, 40) } : {}),
      ...(input.done ? { onboardedAt: new Date().toISOString() } : {}),
      ...(input.hideGettingStarted !== undefined ? { gettingStartedHidden: input.hideGettingStarted } : {}),
    };
    this.store.append({ aggregate: "member", type: "MemberUpdated", aggregateId: memberId, payload }, memberId === "me" ? "user" : `member:${memberId}`);
    return this.memberOrThrow(memberId);
  }

  setPreferences(memberId: string, prefs: { systemPrompt: string }): Member {
    this.memberOrThrow(memberId);
    this.store.append({ aggregate: "member", type: "MemberUpdated", aggregateId: memberId, payload: { systemPrompt: prefs.systemPrompt.slice(0, 20_000) } }, memberId === "me" ? "user" : `member:${memberId}`);
    return this.memberOrThrow(memberId);
  }

  remove(id: string, by: RequestIdentity): void {
    const m = this.memberOrThrow(id);
    if (m.role === "owner") throw new ConflictError("The owner cannot be removed");
    if (by.role === "member") throw new ConflictError("Only admins can remove members");
    this.store.append({ aggregate: "member", type: "MemberRemoved", aggregateId: id, payload: {} }, by.actor);
    const pw = this.passwords();
    delete pw[id];
    this.secrets.set("passwords", JSON.stringify(pw));
    this.write("sessions", this.read<Session>("sessions").filter((s) => s.memberId !== id));
  }

  /** A new team server's owner account, from its environment (CADENCE_OWNER_EMAIL and CADENCE_OWNER_PASSWORD). */
  async bootstrapOwner(input: { email: string; password: string; name?: string }): Promise<void> {
    this.ensureOwner();
    const email = normEmail(input.email);
    if (!EMAIL.test(email)) throw new ValidationError("CADENCE_OWNER_EMAIL does not look like an email address");
    await this.setPassword("me", input.password);
    this.store.append({ aggregate: "member", type: "MemberUpdated", aggregateId: "me", payload: { email, ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {}) } }, "system");
  }

  async setPassword(memberId: string, password: string): Promise<void> {
    this.memberOrThrow(memberId);
    const weak = checkPasswordStrength(password);
    if (weak) throw new ValidationError(weak);
    const pw = this.passwords();
    pw[memberId] = await hashPassword(password);
    this.secrets.set("passwords", JSON.stringify(pw));
  }

  private newSession(memberId: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const live = this.read<Session>("sessions").filter((s) => Date.now() - Date.parse(s.lastSeen) < SESSION_IDLE_MS);
    this.write("sessions", [...live, { hash: sha(token), memberId, createdAt: now, lastSeen: now }]);
    return token;
  }

  async login(email: string, password: string): Promise<{ member: Member; token: string }> {
    const member = this.q.members().find((m) => m.email && m.email === normEmail(email));
    const stored = member ? this.passwords()[member.id] : undefined;
    // Same work whether or not the account exists, so timing does not reveal emails.
    const ok = await verifyPassword(password, stored ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAA");
    if (!member || !stored || !ok) throw new ValidationError("Wrong email or password");
    return { member, token: this.newSession(member.id) };
  }

  logout(token: string): void {
    const h = sha(token);
    this.write("sessions", this.read<Session>("sessions").filter((s) => !same(s.hash, h)));
  }

  /** The member behind a session cookie, refreshing its idle timer at most once a minute. */
  identify(token: string | undefined): RequestIdentity | null {
    if (!token) return null;
    const h = sha(token);
    const sessions = this.read<Session>("sessions");
    const s = sessions.find((x) => same(x.hash, h));
    if (!s || Date.now() - Date.parse(s.lastSeen) > SESSION_IDLE_MS) return null;
    const m = this.q.member(s.memberId);
    if (!m) return null;
    if (Date.now() - Date.parse(s.lastSeen) > 60_000) {
      s.lastSeen = new Date().toISOString();
      this.write("sessions", sessions);
    }
    return { actor: actorForMember(m.id), memberId: m.id, role: m.role };
  }

  invites(): Omit<Invite, "hash">[] {
    return this.read<Invite>("invites")
      .filter((i) => Date.parse(i.expiresAt) > Date.now())
      .map(({ hash: _h, ...i }) => i);
  }

  createInvite(role: Invite["role"], by: RequestIdentity, email?: string): { token: string; invite: Omit<Invite, "hash"> } {
    if (by.role === "member") throw new ConflictError("Only admins can invite people");
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const invite: Invite = { id: randomUUID(), role, createdBy: by.memberId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + INVITE_MS).toISOString(), ...(email ? { email } : {}), hash: sha(token) };
    this.write("invites", [...this.read<Invite>("invites").filter((i) => Date.parse(i.expiresAt) > now), invite]);
    const { hash: _h, ...pub } = invite;
    return { token, invite: pub };
  }

  revokeInvite(id: string): void {
    this.write("invites", this.read<Invite>("invites").filter((i) => i.id !== id));
  }

  /** Looks an invite up without using it (for the accept page). */
  peekInvite(token: string): Omit<Invite, "hash"> | null {
    const h = sha(token);
    const i = this.read<Invite>("invites").find((x) => same(x.hash, h) && Date.parse(x.expiresAt) > Date.now());
    if (!i) return null;
    const { hash: _h, ...pub } = i;
    return pub;
  }

  async acceptInvite(token: string, input: { name: string; email: string; password: string }): Promise<{ member: Member; token: string }> {
    const invite = this.peekInvite(token);
    if (!invite) throw new ValidationError("This invite link has expired or was already used");
    const email = normEmail(input.email);
    if (!EMAIL.test(email)) throw new ValidationError("That email address does not look right");
    if (this.q.members().some((m) => m.email === email)) throw new ConflictError("Someone with that email is already a member; sign in instead");
    const weak = checkPasswordStrength(input.password);
    if (weak) throw new ValidationError(weak);
    const id = randomUUID();
    const color = COLORS[this.q.members().length % COLORS.length]!;
    this.store.append({ aggregate: "member", type: "MemberJoined", aggregateId: id, payload: { name: input.name.trim().slice(0, 60), email, role: invite.role, color } }, `member:${id}`);
    await this.setPassword(id, input.password);
    this.revokeInvite(invite.id);
    return { member: this.memberOrThrow(id), token: this.newSession(id) };
  }

  requests(): AccessRequest[] {
    return this.read<AccessRequest>("requests");
  }

  requestAccess(input: { name: string; email: string; message: string }): void {
    const email = normEmail(input.email);
    if (!EMAIL.test(email)) throw new ValidationError("That email address does not look right");
    const list = this.requests();
    if (list.some((r) => r.email === email) || this.q.members().some((m) => m.email === email)) return;
    if (list.length >= MAX_REQUESTS) throw new ConflictError("Too many pending requests; ask an admin directly");
    this.write("requests", [...list, { id: randomUUID(), name: input.name.trim().slice(0, 60), email, message: input.message.trim().slice(0, 500), createdAt: new Date().toISOString() }]);
  }

  /** Approving answers with an invite link to send to the requester. */
  approveRequest(id: string, role: Invite["role"], by: RequestIdentity): { token: string; request: AccessRequest; invite: Omit<Invite, "hash"> } {
    const request = this.requests().find((r) => r.id === id);
    if (!request) throw new NotFoundError("Request not found");
    const { token, invite } = this.createInvite(role, by, request.email);
    this.write("requests", this.requests().filter((r) => r.id !== id));
    return { token, request, invite };
  }

  denyRequest(id: string): void {
    this.write("requests", this.requests().filter((r) => r.id !== id));
  }
}
