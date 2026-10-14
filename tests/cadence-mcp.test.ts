import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createContainer, type Container } from "../src/server/container";
import { filterTools, isReadOnly, toolsetOf } from "../src/agents/toolsets";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

const BIN = resolve("packages/cadence-mcp/bin.mjs");
const run = promisify(execFile);

describe("toolsets, read-only connections, and the cadence-mcp bridge", () => {
  let dir: string;
  let c: Container;
  let server: Server;
  let base: string;

  const boot = async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-mcpcli-"));
    c = createContainer({ dataDir: dir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
    server = createApp(c, { apiToken: null, staticDir: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(() => {
    server?.close();
    c?.stop();
    c?.db.close();
    if (dir) removeTempDir(dir);
  });

  it("sorts tools into toolsets and keeps writers off read-only connections", () => {
    expect(toolsetOf("issues_bulk_update")).toBe("issues");
    expect(toolsetOf("canvas_reply")).toBe("comments");
    expect(toolsetOf("canvas_screenshot")).toBe("canvas");
    for (const name of ["issues_list", "docs_grep", "agents_list_runs", "slack_read_thread", "comments_inbox", "board_overview", "pr_status"]) expect(isReadOnly(name), name).toBe(true);
    for (const name of ["issues_create", "issues_share_link", "docs_delete", "slack_send_dm", "comments_resolve", "scripts_configure", "pr_open"]) expect(isReadOnly(name), name).toBe(false);
    const tools = ["issues_list", "issues_create", "docs_get"].map((name) => ({ name, description: "", shape: {}, run: () => "" }));
    expect(filterTools(tools, { toolsets: ["issues"], readonly: true }).map((t) => t.name)).toEqual(["issues_list"]);
  });

  it("logs in, serves over stdio with toolsets and a bound workspace, and answers whoami", async () => {
    await boot();
    const ws = await c.workspaces.createInProject(null, "Design", "user");
    const env = { ...process.env, CADENCE_URL: base, CADENCE_MCP_CONFIG: join(dir, "mcp.json"), CADENCE_AUTH_TOKEN: "" };

    // A Cadence on this machine trusts loopback, so login can mint a token itself.
    await run(process.execPath, [BIN, "login"], { env });
    const saved = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) as { url: string; token: string };
    expect(saved.url).toBe(base);
    expect(saved.token).toMatch(/^cad_/);
    expect((await run(process.execPath, [BIN, "whoami", "--workspace", ws.path], { env })).stdout).toContain(`Workspace: Design (id ${ws.id}`);

    const connect = async (...args: string[]) => {
      const client = new Client({ name: "host", version: "1.0.0" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, ...args], env: env as Record<string, string>, stderr: "pipe" }));
      return client;
    };
    const docsOnly = await connect("--toolsets", "docs", "--readonly", "--workspace", ws.path);
    const names = (await docsOnly.listTools()).tools.map((t) => t.name);
    expect(names).toContain("docs_grep");
    expect(names).not.toContain("docs_create");
    expect(names.every((n) => n.startsWith("docs_"))).toBe(true);
    await docsOnly.close();

    const full = await connect("--workspace", ws.path);
    const all = (await full.listTools()).tools.map((t) => t.name);
    // Bound to a workspace, the canvas tools come along.
    expect(all).toEqual(expect.arrayContaining(["issues_create", "canvas_list", "comments_inbox", "cadence_whoami"]));
    const created = await full.callTool({ name: "issues_create", arguments: { title: "From outside", body: "via stdio", type: "chore", priority: "low" } });
    expect((created.content as { text: string }[])[0]!.text).toMatch(/^Created CAD-\d+\.$/);
    expect(c.q.issues().find((i) => i.title === "From outside")!.createdBy).toMatch(/^token:/);
    await full.close();

    // Without a workspace there are no canvas tools.
    const loose = await connect("--workspace", tmpdir());
    expect((await loose.listTools()).tools.map((t) => t.name)).not.toContain("canvas_list");
    await loose.close();
  }, 60_000);
});
