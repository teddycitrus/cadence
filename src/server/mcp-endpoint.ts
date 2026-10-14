import { resolve, sep } from "node:path";
import express, { Router, type Request } from "express";
import { boardTools, callBoardTool, toolContent, type ToolContext } from "../agents/board-tools";
import { filterTools, parseToolsets } from "../agents/toolsets";
import type { Workspace } from "../core/types";
import type { Container } from "./container";
import { publicBase } from "./routes/oauth";

const flag = (v: unknown) => v === "1" || v === "true" || v === true;

/** The workspace a connection names, by id or by a folder inside it (an agent running in a worktree). */
export function boundWorkspace(c: Container, ref: string | undefined): Workspace | null {
  if (!ref) return null;
  const byId = c.q.workspace(ref);
  if (byId) return byId;
  // Windows paths are case-insensitive; elsewhere they are not.
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const target = norm(ref);
  const inside = (ws: Workspace) => {
    const root = norm(ws.path);
    return target === root || target.startsWith(root + sep);
  };
  // The longest match wins, so a worktree beats the project folder that holds the data dir.
  return c.q.workspaces(false).filter(inside).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

function connectionOptions(req: Request) {
  const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
  return {
    toolsets: parseToolsets(req.query.toolsets ?? header("x-cadence-toolsets")),
    readonly: flag(req.query.readonly) || flag(header("x-cadence-readonly")),
    workspace: (typeof req.query.workspace === "string" ? req.query.workspace : undefined) ?? header("x-cadence-workspace"),
  };
}

/**
 * Cadence's tools over MCP (streamable HTTP, stateless) for agents outside
 * Cadence. Each request carries a personal access token from Settings, and
 * actions are attributed to it. A connection can narrow itself with
 * `?toolsets=issues,docs` and `?readonly=1`, and name its workspace with
 * `?workspace=<id or folder>` to reach canvas and browser tools.
 */
export function mcpEndpoint(c: Container): Router {
  const r = Router();
  r.use(express.json({ limit: "4mb" }));

  r.post("/", async (req, res) => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    // A chat on another harness (Codex, Cursor, ...) reaches its own session's tools this way.
    const session = c.toolBridge.lookup(bearer);
    const token = session ? null : c.mcpTokens.verify(bearer);
    if (!session && !token) {
      // Tells OAuth-capable clients where to sign in (RFC 9728).
      res.set("WWW-Authenticate", `Bearer resource_metadata="${publicBase(req)}/.well-known/oauth-protected-resource"`);
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid Cadence token. Create one in Settings > Integrations." }, id: null });
      return;
    }
    const opts = connectionOptions(req);
    let tools = session?.tools;
    let ctx: ToolContext;
    if (session) ctx = session.ctx;
    else {
      const role = token!.memberId === "me" ? "owner" : c.q.member(token!.memberId)?.role;
      // Workspace tools write files and drive a browser on the host, so members' tokens do not get them.
      const ws = role === "member" ? null : boundWorkspace(c, opts.workspace);
      ctx = { actor: `token:${token!.id}`, runId: null, issueId: null, ownerId: token!.memberId, workspaceId: ws?.id ?? null };
      tools = [...boardTools({ q: c.q, issues: c.issues, docs: c.docs, prs: c.prs, extra: c.integrationTools() }), ...(ws ? c.workspaceTools() : [])];
    }
    tools = filterTools(tools!, opts);
    // The MCP SDK loads with the first connection; servers nobody connects to never pay for it.
    const [{ McpServer }, { StreamableHTTPServerTransport }] = await Promise.all([import("@modelcontextprotocol/sdk/server/mcp.js"), import("@modelcontextprotocol/sdk/server/streamableHttp.js")]);
    const server = new McpServer({ name: "cadence", version: "0.1.0" });
    for (const t of tools) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args: unknown) => {
        const result = await callBoardTool(tools!, t.name, args, ctx);
        return { content: toolContent(result), isError: result.isError };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless: there are no sessions to stream to or end.
  r.get("/", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "Use POST" }));
  r.delete("/", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "Use POST" }));
  return r;
}
