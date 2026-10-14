import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { ConflictError, ForbiddenError, GateError, NotFoundError, ValidationError } from "../core/errors";
import type { Container } from "./container";
import { agentRoutes } from "./routes/agents";
import { assetRoutes } from "./routes/assets";
import { DocConflictError } from "../docs/commands";
import { boardRoutes } from "./routes/board";
import { chatRoutes } from "./routes/chats";
import { workspaceRoutes } from "./routes/workspaces";
import { gitRoutes } from "./routes/git";
import { canvasHomeRoutes, canvasRoutes } from "./routes/canvas";
import { BrowserError } from "../canvas/browser";
import { FigmaError } from "../canvas/figma";
import { terminalRoutes } from "./routes/terminals";
import { integrationRoutes } from "./routes/integrations";
import { mcpEndpoint } from "./mcp-endpoint";
import { SlackError } from "../integrations/slack/api";
import { LinearError } from "../integrations/linear/api";
import { githubRoutes } from "./routes/github";
import { GitError } from "../git/git";
import { GitHubError } from "../git/github";
import { docRoutes } from "./routes/docs";
import { hookRoutes } from "./routes/hooks";
import { issueRoutes } from "./routes/issues";
import { projectRoutes } from "./routes/projects";
import { startRoutes } from "./routes/start";
import { runRoutes } from "./routes/runs";
import { systemRoutes } from "./routes/system";
import { memberRoutes, publicAuthRoutes } from "./routes/auth";
import { publicShareRoutes, shareRoutes } from "./routes/share";
import { adminOnly, authenticate, hostActions } from "./auth-middleware";
import { machineRoutes } from "./routes/machines";
import { issueViewRoutes } from "./routes/issue-views";
import { fileRoutes } from "./routes/files";
import { providerRoutes } from "./routes/providers";
import { OAuthServer } from "../integrations/oauth";
import { oauthConsentRoutes, publicOAuthRoutes } from "./routes/oauth";

export interface AppOptions {
  apiToken: string | null;
  staticDir: string | null;
  /** Treat requests from this machine as the owner. Defaults to on unless an API token is set. */
  trustLocal?: boolean;
  /** Session cookie name (per organization). */
  cookie?: string;
}

export function createApp(c: Container, options: AppOptions) {
  const app = express();
  app.disable("x-powered-by");

  app.use("/api/hooks", hookRoutes(c));
  // Chat apps that take only a connector URL sign in to /mcp with OAuth.
  const oauth = new OAuthServer(c.secrets, c.mcpTokens);
  app.use(publicOAuthRoutes(oauth));
  app.use("/mcp", mcpEndpoint(c));
  app.use(express.json({ limit: "40mb" }));

  const auth = { apiToken: options.apiToken, trustLocal: options.trustLocal ?? !options.apiToken, cookie: options.cookie };
  app.use("/api/auth", publicAuthRoutes(c, auth));
  app.use("/api/share", publicShareRoutes(c));
  app.use("/api", authenticate(c.auth, auth));
  app.use("/api/oauth", oauthConsentRoutes(oauth, c));

  // Everyone signed in: the board, docs, and comments.
  app.use("/api", systemRoutes(c));
  app.use("/api", boardRoutes(c));
  app.use("/api/issues", issueRoutes(c));
  app.use("/api/board", issueViewRoutes(c));
  app.use("/api/docs", docRoutes(c));
  app.use("/api/assets", assetRoutes(c));
  app.use("/api/members", memberRoutes(c));
  app.use("/api/shares", shareRoutes(c));
  // Actions that run on the host machine: owner and admins (members can read).
  const host = hostActions();
  // A teammate may edit a public agent its owner opened for editing (the route checks); running stays with owners and admins.
  app.use("/api/agents", hostActions((req) => req.method === "PATCH" && /^\/[^/]+$/.test(req.path)), agentRoutes(c));
  app.use("/api/runs", host, runRoutes(c));
  // Members may keep their own scripts; the route refuses shared ones.
  app.use("/api/projects", hostActions((req) => req.method === "PUT" && /^\/[^/]+\/scripts$/.test(req.path)), projectRoutes(c));
  app.use("/api/start", host, startRoutes(c));
  app.use("/api/workspaces/:id/git", host, gitRoutes(c));
  app.use("/api/workspaces/:id/files", host, fileRoutes(c));
  app.use("/api/workspaces/:id/canvas", hostActions((req) => req.path.startsWith("/comments")), canvasRoutes(c));
  app.use("/api/canvases", canvasHomeRoutes(c));
  app.use("/api/workspaces", host, workspaceRoutes(c));
  app.use("/api", host, githubRoutes(c));
  app.use("/api/terminals", host, terminalRoutes(c));
  app.use("/api/integrations", host, integrationRoutes(c));
  // Keys and commands for harnesses on this machine: admins only, even to read.
  app.use("/api/providers", adminOnly, providerRoutes(c));
  app.use("/api/machines", adminOnly, machineRoutes(c));
  app.use("/api/chats", host, chatRoutes(c));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    const dir = options.staticDir;
    app.use(express.static(dir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile("index.html", { root: dir }));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DocConflictError) {
      res.status(409).json({ error: err.message, current: err.current });
    } else if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    } else if (err instanceof ValidationError || err instanceof SyntaxError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof ForbiddenError) {
      res.status(403).json({ error: err.message });
    } else if (err instanceof GitHubError) {
      res.status(err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 ? 409 : 502).json({ error: err.message });
    } else if (err instanceof SlackError) {
      res.status(err.code === "not_connected" || err.code.startsWith("invalid") ? 409 : 502).json({ error: err.message });
    } else if (err instanceof LinearError) {
      res.status(err.status === 401 || err.status >= 500 ? 502 : 409).json({ error: err.message });
    } else if (err instanceof FigmaError) {
      res.status(502).json({ error: err.message });
    } else if (err instanceof BrowserError) {
      res.status(503).json({ error: err.message });
    } else if (err instanceof GitError) {
      res.status(409).json({ error: err.message });
    } else if (err instanceof ConflictError || err instanceof GateError) {
      res.status(409).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
