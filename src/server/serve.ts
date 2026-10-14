import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { LlmGateway } from "../agents/llm";
import type { ChatRuntime } from "../agents/runtime";
import { DEFAULT_ORG, OrgRegistry, type Org } from "../orgs/registry";
import { identify } from "./auth-middleware";
import { attachBrowserSockets } from "./browser-socket";
import { createContainer, type ContainerOptions } from "./container";
import { OrgHost } from "./org-host";
import { orgRoutes } from "./routes/orgs";
import { attachTerminalSockets } from "./terminal-socket";
import { MachineLink } from "../machines/link";
import { machineLinkRoutes } from "./routes/machine-link";
import { attachLspSockets } from "../lsp/socket";
import compression from "compression";

export interface CadenceOptions {
  dataDir: string;
  port: number;
  host: string;
  apiToken: string | null;
  trustLocal: boolean;
  staticDir: string | null;
  llm: LlmGateway;
  /** The Claude Code runtime for one org (each org gets its own, with that org's keys). */
  runtimeFor: (org: Org, providerEnv: (model?: string) => NodeJS.ProcessEnv) => ChatRuntime;
  /** Extra container options, for tests (in-memory databases, fake fetch). */
  containerOptions?: Partial<ContainerOptions>;
}

export interface Cadence {
  server: Server;
  link: MachineLink | null;
  orgs: OrgHost;
  url: string;
  close(): Promise<void>;
}

/** Starts Cadence: every organization side by side behind one HTTP server. */
export async function startCadence(o: CadenceOptions): Promise<Cadence> {
  const uiOrigins = [...new Set([`http://${o.host}:${o.port}`, `http://127.0.0.1:${o.port}`, `http://localhost:${o.port}`, "http://127.0.0.1:5173", "http://localhost:5173"])];
  const orgs = new OrgHost(new OrgRegistry(o.dataDir), {
    apiToken: o.apiToken,
    trustLocal: o.trustLocal,
    makeContainer: (org) => {
      let env: (model?: string) => NodeJS.ProcessEnv = () => process.env;
      const runtime = o.runtimeFor(org, (model?: string) => env(model));
      const container = createContainer({ dataDir: org.dir, runtime, llm: o.llm, uiOrigins, org: () => ({ id: org.id, name: orgs.registry.get(org.id)?.name ?? org.name }), ...o.containerOptions });
      env = (model) => container.providers.env("claude-code", model);
      return container;
    },
    attachSockets: (e) => {
      const auth = { apiToken: o.apiToken, trustLocal: o.trustLocal, cookie: e.cookie };
      // Anyone signed in can co-edit docs.
      e.container.collab.attach(e.upgrades, (req) => identify(req, e.container.auth, auth));
      // Terminals and the built-in browser run on this machine: owner and admins only.
      const hostOnly = (req: Parameters<typeof identify>[0]) => {
        const who = identify(req, e.container.auth, auth);
        return Boolean(who && who.role !== "member");
      };
      attachTerminalSockets(e.upgrades, e.container.terminals, hostOnly);
      attachBrowserSockets(e.upgrades, e.container.builtInBrowser, e.container.workspaces, hostOnly);
      attachLspSockets(e.upgrades, e.container.workspaces, hostOnly);
      // Other computers connect here to be opened through this hub; their relays admit owner and admins.
      e.container.machines.configure({ authorize: hostOnly, bindHost: o.host });
      e.upgrades.on("upgrade", (req, socket, head) => {
        if (new URL(req.url ?? "/", "http://localhost").pathname === "/api/machines/connect") e.container.machines.handleUpgrade(req, socket, head);
      });
    },
  });
  orgs.openAll();

  const first = orgs.get(DEFAULT_ORG)!;
  if (o.host !== "127.0.0.1" && o.host !== "localhost" && !o.apiToken && !first.container.auth.hasTeam()) {
    orgs.stopAll();
    throw new Error("Refusing to listen on a network address before sign-in is set up. Set a password in Settings > Members (or CADENCE_API_TOKEN) first.");
  }

  const app = express();
  app.disable("x-powered-by");
  // Snapshots and the web bundle compress several times over, which matters through machine tunnels and hosted teams.
  // Event streams stay uncompressed so each event goes out as it happens.
  app.use(compression({ filter: (req, res) => !String(res.getHeader("Content-Type") ?? "").startsWith("text/event-stream") && compression.filter(req, res) }));
  app.use("/api/orgs", orgRoutes(orgs, { apiToken: o.apiToken, trustLocal: o.trustLocal }));
  // This install's link to a hub; it learns the port once the server is listening.
  let link: MachineLink | null = null;
  let linkRouter: express.Router | null = null;
  app.use("/api/machine-link", (req, res, next) => (linkRouter ? linkRouter(req, res, next) : res.status(503).json({ error: "Starting" })));
  // Not mounted at a path: Express would strip it, and each org's app expects the full /api/... path.
  const toOrg = orgs.dispatch();
  app.use((req, res, next) => (req.path.startsWith("/api/") || req.path === "/mcp" || req.path.startsWith("/mcp/") || req.path.startsWith("/oauth/") || req.path.startsWith("/.well-known/oauth-") ? toOrg(req, res, next) : next()));
  if (o.staticDir && existsSync(o.staticDir)) {
    const dir = o.staticDir;
    app.use(express.static(dir));
    app.get(/^(?!\/api\/|\/mcp).*/, (_req, res) => res.sendFile("index.html", { root: dir }));
  }

  // Express 5 calls this back on failure too, with the error.
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(o.port, o.host, (err?: Error) => (err ? reject(err) : resolve(s)));
  }).catch((err: NodeJS.ErrnoException) => {
    orgs.stopAll();
    throw err.code === "EADDRINUSE" ? new Error(`Port ${o.port} is already in use (is Cadence already running?). Stop the other process or set CADENCE_PORT.`) : err;
  });
  const port = (server.address() as AddressInfo).port;
  // Other harnesses reach their session's board tools over loopback.
  orgs.listening(`http://127.0.0.1:${port}`);
  orgs.attachUpgrades(server);
  link = new MachineLink(o.dataDir, port);
  linkRouter = machineLinkRoutes(link, (r) => identify(r, first.container.auth, { apiToken: o.apiToken, trustLocal: o.trustLocal, cookie: first.cookie }));
  link.start();
  return {
    server,
    orgs,
    url: `http://${o.host}:${port}`,
    link,
    close: async () => {
      link?.stop();
      orgs.stopAll();
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}
