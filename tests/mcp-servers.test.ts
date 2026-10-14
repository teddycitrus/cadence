import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forAcp, forClaude, McpServers, type McpServerConfig } from "../src/integrations/mcp-servers";
import { SecretStore } from "../src/integrations/secrets";
import type { FakeRuntime } from "./helpers/fake-runtime";
import { until } from "./helpers/fake-runtime";
import { bootTeam } from "./helpers/team";
import { removeTempDir } from "./helpers/temp-dir";

const pg: McpServerConfig = { name: "postgres", transport: "stdio", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://secret" }, url: "", headers: {}, defaultOn: true };
const docs: McpServerConfig = { name: "docs", transport: "http", command: "", args: [], env: {}, url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" }, defaultOn: false };

describe("team MCP servers", () => {
  const dirs: string[] = [];
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    for (const d of dirs.splice(0)) removeTempDir(d);
  });

  it("keeps secrets out of the browser and keeps saved values when edited", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-mcp-"));
    dirs.push(dir);
    const store = new McpServers(new SecretStore(dir));
    store.save(pg);
    store.save(docs);
    expect(store.list()).toEqual([
      expect.objectContaining({ name: "postgres", envKeys: ["DATABASE_URL"], headerKeys: [] }),
      expect.objectContaining({ name: "docs", envKeys: [], headerKeys: ["Authorization"] }),
    ]);
    expect(JSON.stringify(store.list())).not.toContain("secret");
    // Editing with the mark keeps the saved value; renaming moves it.
    store.save({ ...pg, name: "db", env: { DATABASE_URL: "********", EXTRA: "1" } }, "postgres");
    expect(store.all().find((s) => s.name === "db")!.env).toEqual({ DATABASE_URL: "postgres://secret", EXTRA: "1" });
    expect(store.all().map((s) => s.name)).toEqual(["docs", "db"]);
    expect(() => store.save({ ...pg, name: "cadence" })).toThrow(/not "cadence"/);
    expect(() => store.save({ ...pg, name: "bad name" })).toThrow();
    expect(() => store.save({ ...docs, name: "x", url: "file:///etc/passwd" })).toThrow(/http or https/);
    expect(() => store.save({ ...pg, name: "docs" }, "db")).toThrow(/already a server/);
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toContain("postgres://secret");
    expect(store.forChat(null).map((s) => s.name)).toEqual(["db"]);
    expect(store.forChat(["docs"]).map((s) => s.name)).toEqual(["docs"]);
    expect(store.forChat([]).map((s) => s.name)).toEqual([]);
  });

  it("hands servers to each harness in its own shape", () => {
    expect(forClaude([pg, docs])).toEqual({
      postgres: { type: "stdio", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://secret" } },
      docs: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" } },
    });
    expect(forAcp([pg, docs], false)).toEqual([{ name: "postgres", command: "npx", args: ["-y", "pg-mcp"], env: [{ name: "DATABASE_URL", value: "postgres://secret" }] }]);
    expect(forAcp([docs], true)).toEqual([{ type: "http", name: "docs", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer abc" }] }]);
  });

  it("lets admins manage servers and chats choose them", async () => {
    const team = await bootTeam();
    close = team.close;
    expect((await team.local("PUT", "/integrations/mcp-servers/postgres", pg)).status).toBe(200);
    const listed = await team.local("GET", "/integrations/mcp-servers");
    expect(JSON.stringify(listed.json)).not.toContain("secret");
    const member = await team.join("member", "Mo");
    expect((await member.call("PUT", "/integrations/mcp-servers/x", { ...pg, name: "x" })).status).toBe(403);

    const ws = await team.c.workspaces.createInProject(null, "Data", "user");
    const chat = team.c.engine.createChat({ workspaceId: ws.id });
    const runtime = team.c.runtime as FakeRuntime;
    runtime.next(async () => "ok");
    await team.c.engine.send(chat.id, { text: "hi" });
    await until(() => runtime.sessions.length === 1);
    expect(runtime.sessions[0]!.options.mcpServers!.map((s) => s.name)).toEqual(["postgres"]);
    await until(() => team.c.q.chat(chat.id)!.status === "idle");

    expect((await team.local("PATCH", `/chats/${chat.id}`, { mcpServers: [] })).json.mcpServers).toEqual([]);
    runtime.next(async () => "ok");
    await team.c.engine.send(chat.id, { text: "again" });
    await until(() => runtime.sessions.length === 2);
    expect(runtime.sessions[1]!.options.mcpServers).toEqual([]);
  });
});
