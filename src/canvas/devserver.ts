import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, PluginOption, ViteDevServer } from "vite";
import type { Queries } from "../core/queries";
import { git } from "../git/git";
import type { WorkspaceService } from "../workspaces/service";
import { cadenceCanvasPlugin } from "./vite-plugin";

const CONFIG_FILES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];
const IDLE_MS = 20 * 60_000;

export interface DevServerInfo {
  workspaceId: string;
  url: string;
  port: number;
  usesProjectConfig: boolean;
  /** Whether the project serves a page at its root (route frames without an app load it). */
  hasPage: boolean;
}

interface Running {
  info: DevServerInfo;
  server: ViteDevServer;
  lastUsed: number;
}

const require = createRequire(import.meta.url);

const REACT_IDS = ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client"];

/** Cadence's own React, for folders that have none. Exact matches, so "react" does not swallow "react/jsx-runtime". */
function reactAliases(): { find: RegExp; replacement: string }[] {
  return REACT_IDS.map((id) => ({ find: new RegExp(`^${id.replace("/", "\\/")}$`), replacement: require.resolve(id) }));
}

/** Cadence's node_modules, which Vite must be allowed to serve when its React is used. */
const cadenceModules = () => dirname(dirname(require.resolve("react/package.json")));

const hasReact = (dir: string) => existsSync(join(dir, "node_modules", "react", "package.json"));

/**
 * Whether the project uses Svelte: it depends on it, or has a .svelte file (a
 * bounded look that skips dependencies and build output). React projects then
 * start without the Svelte plugin and its dependency pre-bundling.
 */
export function usesSvelte(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    if (["dependencies", "devDependencies", "peerDependencies"].some((k) => pkg[k] && ("svelte" in pkg[k]! || "@sveltejs/kit" in pkg[k]!))) return true;
  } catch {
    // no readable package.json: look at the files
  }
  const skip = new Set(["node_modules", ".git", "dist", "build", ".svelte-kit", ".next", ".turbo", ".cadence"]);
  const queue = [root];
  for (let seen = 0; queue.length && seen < 4000; ) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      if (e.isFile() && e.name.endsWith(".svelte")) return true;
      if (e.isDirectory() && !skip.has(e.name)) queue.push(join(dir, e.name));
    }
  }
  return false;
}

/** The project's Svelte Vite plugin when it has one, else Cadence's (it only touches .svelte files). */
async function sveltePlugin(root: string): Promise<PluginOption> {
  let path: string;
  try {
    path = createRequire(join(root, "package.json")).resolve("@sveltejs/vite-plugin-svelte");
  } catch {
    path = require.resolve("@sveltejs/vite-plugin-svelte");
  }
  const mod = (await import(pathToFileURL(path).href)) as { svelte: () => PluginOption };
  return mod.svelte();
}

/**
 * For folders without Svelte installed: resolves `svelte` and its subpaths
 * (which compiled components import) from Cadence's own copy.
 */
function cadenceSvelteFallback(): Plugin {
  const anchor = require.resolve("svelte/package.json");
  return {
    name: "cadence-svelte-fallback",
    enforce: "pre",
    async resolveId(id, _importer, options) {
      if (!/^svelte(\/|$)/.test(id)) return null;
      return this.resolve(id, anchor, { ...options, skipSelf: true });
    },
  };
}

/**
 * Worktrees have no node_modules of their own. When the project ignores
 * node_modules, link the main checkout's so the worktree resolves the same
 * packages (a junction on Windows, which needs no special rights).
 */
export async function linkDependencies(path: string, projectPath: string | null): Promise<void> {
  const target = join(path, "node_modules");
  if (!projectPath || existsSync(target) || !existsSync(join(projectPath, "node_modules"))) return;
  // check-ignore prints the path only when it is ignored.
  if ((await git(path, ["check-ignore", "node_modules"], true)) !== "node_modules") return;
  try {
    symlinkSync(join(projectPath, "node_modules"), target, "junction");
  } catch {
    // Without it, the canvas devserver falls back to Cadence's React and Svelte.
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * One Vite devserver per workspace renders its canvases. A Vite project's own
 * config (aliases, Tailwind, plugins) is used; anything else gets React and
 * Cadence's plugin, which is enough for components with plain CSS imports.
 */
export class CanvasDevServers {
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<DevServerInfo>>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private workspaces: WorkspaceService,
    private q: Queries,
    private parentOrigins: string[],
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  get(workspaceId: string): DevServerInfo | null {
    return this.running.get(workspaceId)?.info ?? null;
  }

  ensure(workspaceId: string): Promise<DevServerInfo> {
    const r = this.running.get(workspaceId);
    if (r) {
      r.lastUsed = Date.now();
      return Promise.resolve(r.info);
    }
    let p = this.starting.get(workspaceId);
    if (!p) {
      p = this.start(workspaceId).finally(() => this.starting.delete(workspaceId));
      this.starting.set(workspaceId, p);
    }
    return p;
  }

  private async start(workspaceId: string): Promise<DevServerInfo> {
    const ws = this.workspaces.workspaceOrThrow(workspaceId);
    await this.workspaces.ensureOnDisk(ws);
    await this.linkDependencies(ws.path, ws.projectId);
    const { createServer } = await import("vite");
    const configFile = CONFIG_FILES.map((f) => join(ws.path, f)).find((f) => existsSync(f));
    const plugins: PluginOption[] = [cadenceCanvasPlugin(ws.path, this.parentOrigins)];
    // Prefer the project's React and Svelte; fall back to Cadence's own.
    const ownReact = !hasReact(ws.path);
    const ownSvelte = !existsSync(join(ws.path, "node_modules", "svelte", "package.json"));
    const svelteProject = usesSvelte(ws.path);
    if (!configFile) {
      plugins.push((await import("@vitejs/plugin-react")).default());
      if (svelteProject) plugins.push(await sveltePlugin(ws.path));
    }
    if (ownSvelte && svelteProject) plugins.push(cadenceSvelteFallback());
    const port = await freePort();
    // Vite caches in node_modules/.vite; when the repo does not ignore node_modules, keep that out of its git status.
    const ignored = !ws.branch || (await git(ws.path, ["check-ignore", "node_modules/.vite"], true)) === "node_modules/.vite";
    const cacheDir = ignored ? undefined : join(tmpdir(), "cadence-vite", workspaceId);
    const server = await createServer({
      root: ws.path,
      ...(cacheDir ? { cacheDir } : {}),
      configFile: configFile ?? false,
      logLevel: "warn",
      clearScreen: false,
      plugins,
      resolve: { dedupe: ["react", "react-dom"], ...(ownReact ? { alias: reactAliases() } : {}) },
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        open: false,
        cors: false,
        fs: { allow: [ws.path, ...(ownReact || ownSvelte ? [cadenceModules()] : []), ...(cacheDir ? [cacheDir] : [])] },
      },
      // React ships as CommonJS, so it is pre-bundled up front instead of on first request.
      optimizeDeps: { entries: [], include: ownReact ? REACT_IDS : [] },
    });
    await server.listen();
    const info: DevServerInfo = { workspaceId, url: `http://127.0.0.1:${port}`, port, usesProjectConfig: Boolean(configFile), hasPage: existsSync(join(ws.path, "index.html")) };
    this.running.set(workspaceId, { info, server, lastUsed: Date.now() });
    return info;
  }

  private linkDependencies(path: string, projectId: string | null): Promise<void> {
    return linkDependencies(path, projectId ? (this.q.project(projectId)?.path ?? null) : null);
  }

  async stop(workspaceId: string): Promise<void> {
    const r = this.running.get(workspaceId);
    if (!r) return;
    this.running.delete(workspaceId);
    await r.server.close().catch(() => undefined);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, r] of this.running) if (now - r.lastUsed > IDLE_MS) void this.stop(id);
  }

  touch(workspaceId: string): void {
    const r = this.running.get(workspaceId);
    if (r) r.lastUsed = Date.now();
  }

  async stopAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}
