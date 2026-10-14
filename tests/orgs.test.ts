import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { startCadence, type Cadence } from "../src/server/serve";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { client } from "./helpers/team";
import { removeTempDir } from "./helpers/temp-dir";

describe("organizations", () => {
  let dir: string;
  let cadence: Cadence;
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    await cadence?.close();
    await new Promise((r) => setTimeout(r, 300));
    removeTempDir(dir);
  });

  const boot = async (trustLocal = true) => {
    dir = mkdtempSync(join(tmpdir(), "cadence-orgs-"));
    cadence = await startCadence({ dataDir: dir, port: 0, host: "127.0.0.1", apiToken: null, trustLocal, staticDir: null, llm: offlineLlm, runtimeFor: () => new FakeRuntime() });
    return `${cadence.url}/api`;
  };

  /** A JSON client that names an org on every request. */
  const inOrg = (base: string, org: string) => async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "x-cadence-org": org }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  it("keeps each organization's data apart and routes requests to the one they name", async () => {
    const api = await boot();
    const local = client(api);
    expect((await local("GET", "/orgs")).json).toEqual([expect.objectContaining({ id: "default", role: "owner", current: true })]);
    const created = await local("POST", "/orgs", { name: "Acme Robotics" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "Acme Robotics", slug: "acme-robotics", role: "owner" });
    const acme = created.json.id as string;

    const first = inOrg(api, "default");
    const second = inOrg(api, acme);
    expect((await first("POST", "/issues", { title: "First org bug", body: "", type: "bug", priority: "low" })).status).toBe(201);
    expect((await second("POST", "/issues", { title: "Acme bug", body: "", type: "bug", priority: "low" })).status).toBe(201);
    expect((await first("GET", "/snapshot")).json.issues.map((i: { title: string }) => i.title)).toEqual(["First org bug"]);
    expect((await second("GET", "/snapshot")).json.issues.map((i: { title: string }) => i.title)).toEqual(["Acme bug"]);
    // ?org= works too (EventSource and share links cannot set headers).
    expect((await (await fetch(`${api}/snapshot?org=${acme}`)).json()).issues).toHaveLength(1);
    expect((await inOrg(api, "nope")("GET", "/snapshot")).json).toMatchObject({ orgMissing: true });

    expect((await local("POST", "/orgs", { name: "Acme Robotics" })).json.slug).toBe("acme-robotics-2");
    expect((await local("POST", "/orgs", { name: "X", slug: "acme-robotics" })).status).toBe(409);
    expect((await local("PATCH", `/orgs/${acme}`, { name: "Acme Inc", slug: "acme" })).json).toMatchObject({ name: "Acme Inc", slug: "acme" });
    expect((await local("DELETE", "/orgs/default")).status).toBe(400);
    expect((await local("DELETE", `/orgs/${acme}`)).status).toBe(200);
    expect((await second("GET", "/snapshot")).status).toBe(404);
    expect((await local("GET", "/orgs")).json.map((o: { name: string }) => o.name)).toEqual(["My organization", "Acme Robotics"]);
  });

  it("signs teammates in per organization and only lets owners manage orgs", async () => {
    const api = await boot();
    const local = client(api);
    const acme = (await local("POST", "/orgs", { name: "Acme" })).json.id as string;
    // An invite to Acme, accepted from elsewhere (no local trust for this client).
    const remote = await startCadenceRemote(api);
    const invite = await inOrg(api, acme)("POST", "/members/invites", { role: "admin" });
    const joined = await remote(`/auth/invite/${invite.json.token}?org=${acme}`, "POST", { name: "Ana", email: "ana@example.com", password: "correct horse battery" });
    expect(joined.status).toBe(201);
    expect(joined.cookie).toMatch(new RegExp(`^cadence_session_${acme.replace(/-/g, "")}=`));
    // Ana sees Acme, not the first org, and cannot create orgs.
    const orgs = await remote("/orgs", "GET", undefined, joined.cookie);
    expect(orgs.json).toEqual([expect.objectContaining({ id: acme, role: "admin" })]);
    expect((await remote("/orgs", "POST", { name: "Mine" }, joined.cookie)).status).toBe(403);
    expect((await remote(`/orgs/${acme}`, "PATCH", { name: "Hijack" }, joined.cookie)).status).toBe(403);
    expect((await remote("/snapshot?org=default", "GET", undefined, joined.cookie)).status).toBe(401);
    expect((await remote(`/snapshot?org=${acme}`, "GET", undefined, joined.cookie)).status).toBe(200);
  });

  it("emails invites through the organization's SMTP server", async () => {
    const received: { to: string; data: string }[] = [];
    const smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onAuth: (auth, _s, cb) => (auth.username === "mailer" && auth.password === "s3cret" ? cb(null, { user: "mailer" }) : cb(new Error("bad login"))),
      onData: (stream, session, cb) => {
        let data = "";
        stream.on("data", (d: Buffer) => (data += d.toString()));
        stream.on("end", () => {
          received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(","), data });
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => smtp.close(() => r(undefined))));
    const smtpPort = (smtp.server.address() as { port: number }).port;

    const api = await boot();
    const local = client(api);
    const acme = (await local("POST", "/orgs", { name: "Acme Robotics" })).json.id as string;
    const org = inOrg(api, acme);
    expect((await org("POST", "/members/invites", { role: "member", email: "sam@example.com" })).status).toBe(400);
    expect((await org("PUT", "/members/email", { host: "127.0.0.1", port: smtpPort, secure: false, user: "mailer", pass: "wrong", from: "Cadence <cadence@acme.test>" })).json.error).toMatch(/refused/);
    expect((await org("PUT", "/members/email", { host: "127.0.0.1", port: smtpPort, secure: false, user: "mailer", pass: "s3cret", from: "Cadence <cadence@acme.test>" })).json).toEqual({ configured: true, host: "127.0.0.1", from: "Cadence <cadence@acme.test>" });

    const sent = await org("POST", "/members/invites", { role: "admin", email: "sam@example.com" });
    expect(sent.status).toBe(201);
    expect(sent.json).toMatchObject({ emailed: true, invite: { email: "sam@example.com", role: "admin" } });
    expect(received).toHaveLength(1);
    expect(received[0]!.to).toBe("sam@example.com");
    // Undo quoted-printable: soft line breaks and =3D.
    const body = received[0]!.data.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
    expect(body).toContain("Subject: Join Acme Robotics on Cadence");
    expect(body).toContain(`#/invite/${sent.json.token}?org=${acme}`);
    // The emailed link works.
    expect((await fetch(`${api}/auth/invite/${sent.json.token}?org=${acme}`).then((r) => r.json())).valid).toBe(true);
    // A send that fails takes its invite back.
    smtp.close();
    await new Promise((r) => setTimeout(r, 200));
    const failed = await org("POST", "/members/invites", { role: "member", email: "late@example.com" });
    expect(failed.status).toBe(400);
    expect((await org("GET", "/members/invites")).json.map((i: { email?: string }) => i.email)).toEqual(["sam@example.com"]);
  }, 30_000);

  /** Requests that do not look local (a forwarded-for header turns local trust off). */
  async function startCadenceRemote(api: string) {
    return async (path: string, method: string, body?: unknown, cookie?: string) => {
      const res = await fetch(api + path, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
    };
  }
});
