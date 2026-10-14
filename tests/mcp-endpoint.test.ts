import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

describe("MCP endpoint for outside agents", () => {
  let dir: string;
  let c: Container;
  let server: Server;
  let base: string;

  const boot = async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-mcp-"));
    c = createContainer({ dataDir: dir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
    server = createApp(c, { apiToken: null, staticDir: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const connect = async (token: string) => {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };

  afterEach(() => {
    server.close();
    c.stop();
    c.db.close();
    removeTempDir(dir);
  });

  it("lets a token holder use the board tools, attributed to the token", async () => {
    await boot();
    const res = await fetch(`${base}/api/integrations/mcp-tokens`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "codex-cloud" }) });
    const { token, info } = (await res.json()) as { token: string; info: { id: string; prefix: string } };
    expect(token).toMatch(/^cad_/);
    // Only a hash is stored.
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain(token);

    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["board_overview", "issues_create", "docs_edit"]));
    const created = await client.callTool({ name: "issues_create", arguments: { title: "From outside", body: "Filed over MCP", type: "bug", priority: "low" } });
    expect((created.content as { text: string }[])[0]!.text).toMatch(/^Created CAD-\d+\.$/);
    expect(c.q.issues()[0]!.createdBy).toBe(`token:${info.id}`);

    // Outside agents stop at sign-off stages like Cadence agents do.
    const gate = c.q.stages().find((s) => s.humanGate)!;
    const issue = c.q.issues()[0]!;
    c.issues.moveIssue(issue.id, gate.id, "user");
    const moved = await client.callTool({ name: "issues_move", arguments: { issue: issue.key, stage: c.q.stages().find((s) => s.category === "done")!.name } });
    expect(moved.isError).toBe(true);
    expect((moved.content as { text: string }[])[0]!.text).toContain("sign-off stage");
    expect(c.mcpTokens.list()[0]!.lastUsedAt).not.toBeNull();
    await client.close();
  });

  it("rejects missing, wrong, and revoked tokens", async () => {
    await boot();
    const { token, info } = c.mcpTokens.create("temp");
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
    await expect(connect("cad_wrong")).rejects.toThrow();
    const ok = await connect(token);
    await ok.close();
    c.mcpTokens.revoke(info.id);
    await expect(connect(token)).rejects.toThrow();
  });
});
