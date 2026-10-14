import { join } from "node:path";
import { AgentCommands } from "../core/agent-commands";
import { openDb } from "../core/db";
import { EventStore } from "../core/event-store";
import { IssueCommands } from "../core/issue-commands";
import { Queries } from "../core/queries";
import type { LlmGateway } from "../agents/llm";
import type { ChatRuntime } from "../agents/runtime";
import { EphemeralBus } from "../core/bus";
import { ChatEngine } from "../chat/engine";
import { WorkspaceService } from "../workspaces/service";
import { DocCommands } from "../docs/commands";
import { AssetStore } from "../docs/assets";
import { RunQueue } from "../runner/run-queue";
import { Scheduler } from "../runner/scheduler";
import { TriggerEngine } from "../runner/triggers";
import { GitHubAuth } from "../git/github";
import { SecretStore } from "../integrations/secrets";
import { McpTokens } from "../integrations/mcp-tokens";
import { AuthService } from "../auth/service";
import { Presence } from "./presence";
import { DocCollab } from "../docs/collab";
import { CanvasService } from "../canvas/service";
import { CanvasDevServers } from "../canvas/devserver";
import { HeadlessBrowser } from "../canvas/browser";
import { CanvasRenderer } from "../canvas/render";
import { CanvasApps } from "../canvas/apps";
import { Mailer } from "../integrations/mail";
import { UsageService } from "../usage/service";
import { MachineHub } from "../machines/hub";
import { McpServers } from "../integrations/mcp-servers";
import { reviewTools } from "../agents/review-tools";
import { BuiltInBrowser } from "../browser/service";
import { browserTools } from "../browser/tools";
import { visualPrTool, visualReviewStatusTool } from "../canvas/vrt-report";
import { canvasTools } from "../canvas/tools";
import { agentTools } from "../agents/agent-tools";
import { scriptTools } from "../agents/script-tools";
import { issueTools } from "../agents/issue-tools";
import { moreSlackTools } from "../integrations/slack/tools-more";
import { commentTools } from "../canvas/comment-tools";
import { hostTools } from "../agents/host-tools";
import { moreCanvasTools } from "../canvas/tools-more";
import { CanvasEditingState } from "../canvas/editing";
import { DesignContext } from "../canvas/design-context";
import { designContextTools } from "../canvas/design-context-tools";
import { visualReviewTools } from "../ci/tools";
import { docTools } from "../agents/doc-tools";
import { moreAgentTools } from "../agents/agent-tools-more";
import { FigmaImporter } from "../canvas/figma";
import { ShareService } from "../share/service";
import { SkillService, skillTools } from "../chat/skills";
import { SlackService } from "../integrations/slack/service";
import { slackTools } from "../integrations/slack/tools";
import { LinearSync } from "../integrations/linear/sync";
import { linearTools } from "../integrations/linear/tools";
import { PullRequestService } from "../git/pull-requests";
import { TerminalService } from "../terminal/service";
import { CliMode } from "../chat/cli-mode";
import { ProviderRegistry } from "../agents/providers";
import { ToolBridge } from "../agents/tool-bridge";
import { Runtimes } from "../agents/registry";
import type { ProviderId } from "../core/providers";
import { useToolchain } from "../projects/node-toolchain";

export interface ContainerOptions {
  dataDir: string;
  dbFile?: string;
  /** The Claude Code runtime. Other harnesses run over ACP unless `runtimes` replaces them. */
  runtime: ChatRuntime;
  runtimes?: Partial<Record<ProviderId, ChatRuntime>>;
  /** Which organization this container is (for invite links and emails). */
  org?: () => { id: string; name: string };
  idleMs?: number;
  llm: LlmGateway;
  /** Stands in for GitHub's, Slack's, and Linear's APIs in tests. */
  fetchImpl?: typeof fetch;
  /** Origins the Cadence UI is served from, which canvas pages may talk to. */
  uiOrigins?: string[];
  /** Stands in for Slack's Socket Mode WebSocket in tests. */
  slackSocket?: (url: string) => import("ws").WebSocket;
}

export type Container = ReturnType<typeof createContainer>;

/** Wires the application together. Tests pass a fake runtime and an in-memory db. */
export function createContainer(options: ContainerOptions) {
  // A Node.js Cadence installed earlier goes first on PATH for everything started from here.
  useToolchain(options.dataDir);
  const db = openDb(options.dbFile ?? join(options.dataDir, "cadence.db"));
  const store = new EventStore(db);
  const q = new Queries(db);
  const issues = new IssueCommands(store, q);
  const agents = new AgentCommands(store, q);
  const docs = new DocCommands(store, q, issues);
  const assets = new AssetStore(store, q, options.dataDir);
  const bus = new EphemeralBus();
  const presence = new Presence(bus);
  const collab = new DocCollab(store, q);
  const secrets = new SecretStore(options.dataDir);
  const github = new GitHubAuth(secrets);
  github.warm();
  const prs = new PullRequestService(store, q, issues, github, options.fetchImpl);
  const workspaces = new WorkspaceService(store, q, options.dataDir);
  const providers = new ProviderRegistry(new SecretStore(options.dataDir, "providers.json"));
  const toolBridge = new ToolBridge();
  const runtimes = new Runtimes(options.runtime, providers, toolBridge, options.runtimes);
  const runtimeFor = (provider: string) => runtimes.get(provider);
  const builtInBrowser = new BuiltInBrowser(options.dataDir);
  const orgInfo = options.org ?? (() => ({ id: "default", name: "Cadence" }));
  const machines = new MachineHub(store, q, () => orgInfo().id);
  const usage = new UsageService(db, q);
  const mcpServers = new McpServers(secrets);
  const engine = new ChatEngine({ store, q, issues, docs, workspaces, runtimes: runtimeFor, bus, idleMs: options.idleMs, prs, guard: (chat) => usage.check(chat), mcpServers: (chosen) => mcpServers.forChat(chosen), extraTools: () => [...integrationTools(), ...workspaceTools()] });
  /** Tools that act on the calling session's workspace (canvases, the built-in browser, PR visuals, skills). */
  const canvasEditing = new CanvasEditingState(bus);
  const workspaceTools = () => [...canvasTools(canvases, canvasRender, q), ...visualReviewTools(canvases, workspaces, q), ...moreCanvasTools({ canvases, render: canvasRender, dev: canvasDev, apps: canvasApps, editing: canvasEditing, shares, workspaces, q }), ...skillTools(skills), ...browserTools(builtInBrowser), visualPrTool(() => ({ workspaces, canvases, canvasRender, prs })), visualReviewStatusTool(() => ({ prs }), q), ...reviewTools()];
  const terminals = new TerminalService(workspaces);
  const cliMode = new CliMode(engine, terminals, workspaces, q, runtimeFor);
  const queue = new RunQueue({ store, q, agents, engine, workspaces });
  const triggers = new TriggerEngine(store, q, agents);
  const scheduler = new Scheduler(store, q, triggers);
  const slack = new SlackService(secrets, q, triggers, options.fetchImpl, options.slackSocket);
  const integrationSettings = new SecretStore(options.dataDir, "integrations.json");
  const canvases = new CanvasService(store, q, workspaces);
  const uiOrigins = options.uiOrigins ?? ["http://127.0.0.1:4317", "http://localhost:4317", "http://127.0.0.1:5173", "http://localhost:5173"];
  const canvasDev = new CanvasDevServers(workspaces, q, uiOrigins);
  const browser = new HeadlessBrowser();
  const canvasApps = new CanvasApps(workspaces, q, uiOrigins);
  const canvasRender = new CanvasRenderer(canvases, canvasDev, browser, workspaces, options.dataDir, canvasApps);
  const figma = new FigmaImporter(secrets, canvases, workspaces, options.fetchImpl);
  const shares = new ShareService(store, q, canvases);
  const skills = new SkillService(store, q);
  const linear = new LinearSync(store, q, issues, secrets, integrationSettings, options.fetchImpl);
  const designContext = new DesignContext();
  const integrationTools = () => [...designContextTools(designContext, canvasRender, q), ...agentTools(q, agents), ...moreAgentTools(q, agents), ...hostTools(q, agents, orgInfo), ...scriptTools(q, agents), ...issueTools({ q, issues, store, shares, assets }), ...docTools(q, docs, shares), ...commentTools(canvases, q), ...(slack.status().configured ? [...slackTools(slack), ...moreSlackTools(slack, q, store)] : []), ...(linear.status().connected ? linearTools(linear) : [])];

  issues.seedDefaults();
  const auth = new AuthService(store, q, new SecretStore(options.dataDir, "auth.json"));
  auth.ensureOwner();

  return {
    dataDir: options.dataDir,
    db,
    store,
    q,
    issues,
    agents,
    docs,
    assets,
    queue,
    bus,
    workspaces,
    engine,
    triggers,
    scheduler,
    secrets,
    presence,
    collab,
    auth,
    canvases,
    canvasDev,
    canvasRender,
    canvasApps,
    builtInBrowser,
    mailer: new Mailer(secrets),
    usage,
    org: orgInfo,
    machines,
    mcpServers,
    figma,
    shares,
    skills,
    mcpTokens: new McpTokens(secrets),
    integrationTools,
    workspaceTools,
    canvasEditing,
    designContext,
    slack,
    linear,
    github,
    prs,
    terminals,
    cliMode,
    fetchImpl: options.fetchImpl ?? fetch,
    runtime: options.runtime,
    runtimes,
    providers,
    toolBridge,
    /** The harness new work uses by default, for one-shot jobs like commit messages. */
    defaultRuntime: () => runtimes.get(q.settings().defaultProvider ?? "claude-code"),
    llm: options.llm,
    start() {
      engine.recover();
      triggers.start();
      queue.start();
      scheduler.start();
      prs.start();
      slack.start();
      linear.start();
    },
    stop() {
      presence.stop();
      collab.stop();
      prs.stop();
      slack.stop();
      linear.stop();
      cliMode.exitAll();
      terminals.closeAll();
      void canvasDev.stopAll();
      void canvasApps.stopAll();
      void builtInBrowser.closeAll();
      machines.stop();
      browser.close();
      scheduler.stop();
      queue.stop();
      engine.stopAll();
      triggers.stop();
    },
  };
}
