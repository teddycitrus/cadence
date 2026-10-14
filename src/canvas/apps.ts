import type { Queries } from "../core/queries";
import type { WorkspaceService } from "../workspaces/service";
import { linkDependencies } from "./devserver";
import { AppProxies } from "./app-proxy";
import { AppDevServers } from "./app-servers";
import type { CanvasFile } from "./parse";

/**
 * Where a canvas's route frames load from when the app has its own dev
 * server: one Cadence starts (appCommand) or one already running (appUrl).
 * Canvas frames go through a proxy that adds the selection bridge.
 */
export class CanvasApps {
  readonly servers = new AppDevServers();
  readonly proxies: AppProxies;

  constructor(
    private workspaces: WorkspaceService,
    private q: Queries,
    parentOrigins: string[],
  ) {
    this.proxies = new AppProxies(parentOrigins);
  }

  /** The app's own URL, starting its dev server when the canvas says how; null when routes come from the canvas devserver. */
  async appUrl(workspaceId: string, canvas: Pick<CanvasFile, "appUrl" | "appCommand">): Promise<string | null> {
    if (canvas.appCommand) {
      const ws = this.workspaces.workspaceOrThrow(workspaceId);
      await this.workspaces.ensureOnDisk(ws);
      await linkDependencies(ws.path, ws.projectId ? (this.q.project(ws.projectId)?.path ?? null) : null);
      return this.servers.ensure(ws.path, canvas.appCommand);
    }
    return canvas.appUrl;
  }

  /** The URL canvas frames load the app through (with the bridge), or null. */
  async frameUrl(workspaceId: string, canvas: Pick<CanvasFile, "appUrl" | "appCommand">): Promise<{ appUrl: string; proxyUrl: string } | null> {
    const appUrl = await this.appUrl(workspaceId, canvas);
    if (!appUrl) return null;
    return { appUrl, proxyUrl: await this.proxies.ensure(appUrl) };
  }

  async stopAll(): Promise<void> {
    this.servers.stopAll();
    await this.proxies.stopAll();
  }
}
