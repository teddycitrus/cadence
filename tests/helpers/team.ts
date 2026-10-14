import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { createContainer, type Container } from "../../src/server/container";
import { FakeRuntime } from "./fake-runtime";
import { offlineLlm } from "./setup";
import { removeTempDir } from "./temp-dir";

export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, any>; setCookie: string | null }>;

/** A tiny cookie-keeping JSON client. */
export function client(base: string): Call {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    return { status: res.status, json: (await res.json()) as Record<string, any>, setCookie: set };
  };
}

/**
 * One container served twice: "local" is the owner on this machine, and
 * `join` signs a teammate in through the untrusted address.
 */
export async function bootTeam(): Promise<{ c: Container; local: Call; localBase: string; join: (role: "member" | "admin", name: string) => Promise<{ call: Call; id: string }>; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "cadence-team-"));
  const c = createContainer({ dataDir: dir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
  const servers: Server[] = [];
  const listen = async (trustLocal: boolean) => {
    const s = createApp(c, { apiToken: null, staticDir: null, trustLocal }).listen(0, "127.0.0.1");
    servers.push(s);
    await new Promise((r) => s.once("listening", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`;
  };
  const localBase = await listen(true);
  const local = client(localBase);
  const remoteBase = await listen(false);
  return {
    c,
    local,
    localBase,
    join: async (role, name) => {
      const invite = await local("POST", "/members/invites", { role });
      const call = client(remoteBase);
      const joined = await call("POST", `/auth/invite/${invite.json.token}`, { name, email: `${name.toLowerCase()}@example.com`, password: "correct horse battery" });
      if (joined.status !== 201) throw new Error(`join failed: ${JSON.stringify(joined.json)}`);
      return { call, id: joined.json.member.id as string };
    },
    close: () => {
      for (const s of servers) s.close();
      c.stop();
      c.db.close();
      removeTempDir(dir);
    },
  };
}
