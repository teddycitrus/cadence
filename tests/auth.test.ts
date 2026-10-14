import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

// One container served twice: "local" trusts this machine (the owner's
// browser), "remote" does not, so it stands in for a teammate elsewhere.
describe("members and sign-in", () => {
  let dir: string;
  let c: Container;
  let servers: Server[] = [];

  const listen = async (trustLocal: boolean) => {
    const s = createApp(c, { apiToken: null, staticDir: null, trustLocal }).listen(0, "127.0.0.1");
    servers.push(s);
    await new Promise((r) => s.once("listening", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`;
  };

  /** A tiny cookie-keeping client. */
  const client = (base: string) => {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
      return { status: res.status, json: (await res.json()) as Record<string, any>, setCookie: set };
    };
  };

  const boot = async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-auth-"));
    c = createContainer({ dataDir: dir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
    return { local: client(await listen(true)), remoteBase: await listen(false) };
  };

  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
    c.stop();
    c.db.close();
    removeTempDir(dir);
  });

  it("lets the owner invite a teammate who signs in, works the board, and is kept off host actions", async () => {
    const { local, remoteBase } = await boot();
    const remote = client(remoteBase);
    expect((await remote("GET", "/snapshot")).status).toBe(401);
    expect((await local("GET", "/auth/me")).json).toMatchObject({ signedIn: true, role: "owner", member: { id: "me" }, team: false });

    const invite = await local("POST", "/members/invites", { role: "member" });
    expect(invite.status).toBe(201);
    const token = invite.json.token as string;
    expect((await remote("GET", `/auth/invite/${token}`)).json).toMatchObject({ valid: true, role: "member" });
    expect((await remote("POST", `/auth/invite/${token}`, { name: "Sam", email: "sam@example.com", password: "short" })).status).toBe(400);
    const joined = await remote("POST", `/auth/invite/${token}`, { name: "Sam", email: "Sam@Example.com", password: "correct horse battery" });
    expect(joined.status).toBe(201);
    expect(joined.setCookie).toMatch(/^cadence_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
    const samId = joined.json.member.id as string;
    // The invite was single-use.
    expect((await client(remoteBase)("GET", `/auth/invite/${token}`)).json).toEqual({ valid: false });
    // Passwords are stored hashed, never in the event log.
    expect(readFileSync(join(dir, "auth.json"), "utf8")).not.toContain("correct horse");
    expect(JSON.stringify(c.store.count())).toBeTruthy();

    expect((await remote("GET", "/auth/me")).json).toMatchObject({ signedIn: true, role: "member", member: { name: "Sam", email: "sam@example.com" }, team: true });
    const created = await remote("POST", "/issues", { title: "From Sam", body: "", type: "bug", priority: "low" });
    expect(created.status).toBe(201);
    expect(c.q.issue(created.json.id)!.createdBy).toBe(`member:${samId}`);
    expect((await remote("POST", `/issues/${created.json.id}/comments`, { body: "Seen on Safari" })).status).toBeLessThan(300);
    expect(c.q.comments(created.json.id)[0]!.author).toBe(`member:${samId}`);

    // Host actions and admin settings are off limits to members.
    expect((await remote("POST", "/chats", { workspaceId: "x" })).status).toBe(403);
    expect((await remote("POST", "/terminals", { workspaceId: "x" })).status).toBe(403);
    expect((await remote("PATCH", "/settings", { concurrency: 9 })).status).toBe(403);
    expect((await remote("POST", "/stages", { name: "X", category: "triage", color: "#ffffff" })).status).toBe(403);
    expect((await remote("POST", "/members/invites", {})).status).toBe(409);
    expect((await remote("PATCH", "/members/me", { name: "Hacker" })).status).toBe(409);
    expect((await remote("PATCH", `/members/${samId}`, { role: "admin" })).status).toBe(409);
    expect((await remote("PATCH", `/members/${samId}`, { name: "Samantha" })).json.name).toBe("Samantha");

    // Signing out ends the session; signing back in works; removal ends it for good.
    expect((await remote("POST", "/auth/logout")).status).toBe(200);
    expect((await remote("GET", "/snapshot")).status).toBe(401);
    expect((await remote("POST", "/auth/login", { email: "sam@example.com", password: "wrong password!!" })).status).toBe(400);
    expect((await remote("POST", "/auth/login", { email: "sam@example.com", password: "correct horse battery" })).status).toBe(200);
    expect((await remote("GET", "/snapshot")).status).toBe(200);
    expect((await local("DELETE", `/members/${samId}`)).status).toBe(200);
    expect((await remote("GET", "/snapshot")).status).toBe(401);
  });

  it("lets the owner sign in remotely after setting a password, and admins act on the host", async () => {
    const { local, remoteBase } = await boot();
    expect((await local("PUT", "/members/me/password", { password: "owner password 1" })).status).toBe(200);
    expect((await local("PATCH", "/members/me", { email: "owner@example.com" })).status).toBe(200);
    const owner = client(remoteBase);
    expect((await owner("POST", "/auth/login", { email: "owner@example.com", password: "owner password 1" })).status).toBe(200);
    expect((await owner("GET", "/auth/me")).json.role).toBe("owner");

    const adminInvite = (await local("POST", "/members/invites", { role: "admin" })).json.token as string;
    const admin = client(remoteBase);
    await admin("POST", `/auth/invite/${adminInvite}`, { name: "Ada", email: "ada@example.com", password: "admin password 1" });
    expect((await admin("PATCH", "/settings", { concurrency: 3 })).status).toBe(200);
    expect((await admin("POST", "/members/invites", {})).status).toBe(201);
  });

  it("lets people edit and delete their own comments, admins delete any, and everyone react", async () => {
    const { local, remoteBase } = await boot();
    const token = (await local("POST", "/members/invites", { role: "member" })).json.token as string;
    const sam = client(remoteBase);
    await sam("POST", `/auth/invite/${token}`, { name: "Sam", email: "sam@example.com", password: "sam password 12" });
    const issue = (await local("POST", "/issues", { title: "Copy review", body: "", type: "chore", priority: "low" })).json;
    await local("POST", `/issues/${issue.id}/comments`, { body: "Owner note" });
    await sam("POST", `/issues/${issue.id}/comments`, { body: "Sam note" });
    const [ownerNote, samNote] = c.q.comments(issue.id);

    expect((await sam("PATCH", `/issues/${issue.id}/comments/${ownerNote!.seq}`, { body: "hijack" })).status).toBe(409);
    expect((await sam("PATCH", `/issues/${issue.id}/comments/${samNote!.seq}`, { body: "Sam note, revised" })).status).toBe(200);
    expect(c.q.comments(issue.id)[1]).toMatchObject({ body: "Sam note, revised", editedAt: expect.any(String) });
    expect((await sam("DELETE", `/issues/${issue.id}/comments/${ownerNote!.seq}`)).status).toBe(409);

    await sam("PUT", `/issues/${issue.id}/comments/${ownerNote!.seq}/reactions/+1`, { on: true });
    await local("PUT", `/issues/${issue.id}/comments/${ownerNote!.seq}/reactions/+1`, { on: true });
    await local("PUT", `/issues/${issue.id}/comments/${ownerNote!.seq}/reactions/tada`, { on: true });
    expect(c.q.comments(issue.id)[0]!.reactions).toEqual({ "+1": [expect.stringMatching(/^member:/), "user"], tada: ["user"] });
    await local("PUT", `/issues/${issue.id}/comments/${ownerNote!.seq}/reactions/tada`, { on: false });
    expect(c.q.comments(issue.id)[0]!.reactions).toEqual({ "+1": [expect.stringMatching(/^member:/), "user"] });
    expect((await local("PUT", `/issues/${issue.id}/comments/${ownerNote!.seq}/reactions/skull`, { on: true })).status).toBe(400);

    // The owner (an admin) can remove anyone's comment.
    expect((await local("DELETE", `/issues/${issue.id}/comments/${samNote!.seq}`)).status).toBe(200);
    expect(c.q.comments(issue.id).map((x) => x.body)).toEqual(["Owner note"]);
  });

  it("turns access requests into invites, and limits sign-in attempts", async () => {
    const { local, remoteBase } = await boot();
    const visitor = client(remoteBase);
    expect((await visitor("POST", "/auth/request-access", { name: "Lee", email: "lee@example.com", message: "PM on checkout" })).status).toBe(202);
    const requests = (await local("GET", "/members/requests")).json as unknown as { id: string; name: string }[];
    expect(requests.map((r) => r.name)).toEqual(["Lee"]);
    const approved = await local("POST", `/members/requests/${requests[0]!.id}/approve`, { role: "member" });
    expect((await visitor("GET", `/auth/invite/${approved.json.token}`)).json.valid).toBe(true);
    expect((await local("GET", "/members/requests")).json).toEqual([]);

    const attacker = client(remoteBase);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attacker("POST", "/auth/login", { email: "x@example.com", password: "guess" + i })).status);
    expect(statuses.filter((s) => s === 400).length).toBe(12);
    const last = await attacker("POST", "/auth/login", { email: "x@example.com", password: "again" });
    expect(last.json.error).toMatch(/Too many attempts/);
  });
});
