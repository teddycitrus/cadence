import { SecretStore } from "../integrations/secrets";
import { ensureCloudflared } from "./cloudflared";
import { Tunnel, type TunnelSpec } from "./tunnel";

// How people elsewhere reach this Cadence. A team server says so with
// CADENCE_PUBLIC_URL. A computer shares itself through a Cloudflare tunnel the
// owner turns on: a quick one (a new address each start) or a named one from
// the owner's own Cloudflare account (a fixed address). Remote viewers' canvas
// frames get a quick tunnel each, on their own site, so a project's code never
// runs on Cadence's origin.

export type SharingMode = "quick" | "named";

export interface SharingStatus {
  state: "off" | "starting" | "on" | "error";
  /** The address teammates use now, or null when nobody outside can reach this Cadence. */
  publicUrl: string | null;
  /** Set by the server's environment (a team server); sharing is then not this computer's to turn on or off. */
  fixed: boolean;
  mode: SharingMode | null;
  error: string | null;
  named: { configured: boolean; url: string | null };
}

export interface SharingOptions {
  dataDir: string;
  /** The port Cadence listens on (known once it is listening). */
  port: () => number;
  /** CADENCE_PUBLIC_URL, for a server that is already reachable. */
  envUrl?: string | null;
  /** Called whenever the public address changes. */
  onChange?: (publicUrl: string | null) => void;
  /** For tests: where cloudflared comes from and how tunnels are made. */
  binary?: () => Promise<string>;
  makeTunnel?: (binary: string, spec: TunnelSpec) => Tunnel;
}

const FRAME_IDLE_MS = 20 * 60_000;

export class SharingService {
  private secrets: SecretStore;
  private tunnel: Tunnel | null = null;
  private state: SharingStatus["state"] = "off";
  private error: string | null = null;
  private mode: SharingMode | null = null;
  private frames = new Map<number, { tunnel: Promise<string>; t: Tunnel | null; lastUsed: number }>();
  private sweeper: NodeJS.Timeout;
  private envUrl: string | null;

  constructor(private o: SharingOptions) {
    this.secrets = new SecretStore(o.dataDir, "sharing.json");
    this.envUrl = o.envUrl ? o.envUrl.replace(/\/+$/, "") : null;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  private binary(): Promise<string> {
    return this.o.binary ? this.o.binary() : ensureCloudflared(this.o.dataDir);
  }

  private make(binary: string, spec: TunnelSpec): Tunnel {
    return this.o.makeTunnel ? this.o.makeTunnel(binary, spec) : new Tunnel(binary, spec);
  }

  publicUrl(): string | null {
    return this.envUrl ?? (this.state === "on" ? (this.tunnel?.url ?? null) : null);
  }

  private named(): { token: string; url: string } | null {
    const raw = this.secrets.get("named");
    return raw ? (JSON.parse(raw) as { token: string; url: string }) : null;
  }

  status(): SharingStatus {
    const named = this.named();
    return {
      state: this.envUrl ? "on" : this.state,
      publicUrl: this.publicUrl(),
      fixed: Boolean(this.envUrl),
      mode: this.mode,
      error: this.error,
      named: { configured: Boolean(named), url: named?.url ?? null },
    };
  }

  /** Saves (or clears) a named tunnel: its token from the Cloudflare dashboard and the address it serves. */
  configureNamed(input: { token: string; url: string } | null): SharingStatus {
    if (input) {
      const url = new URL(input.url);
      if (url.protocol !== "https:") throw new Error("The tunnel's address should start with https://");
      this.secrets.set("named", JSON.stringify({ token: input.token.trim(), url: url.origin }));
    } else this.secrets.set("named", null);
    return this.status();
  }

  private changed(): void {
    this.o.onChange?.(this.publicUrl());
  }

  /** Turns sharing on. It stays on across restarts until turned off. */
  async start(mode: SharingMode): Promise<SharingStatus> {
    if (this.envUrl) return this.status();
    await this.stopTunnel();
    const named = this.named();
    if (mode === "named" && !named) throw new Error("Add a Cloudflare tunnel token and its address first");
    this.state = "starting";
    this.mode = mode;
    this.error = null;
    this.secrets.set("enabled", mode);
    try {
      const tunnel = this.make(await this.binary(), mode === "named" ? { kind: "named", ...named! } : { kind: "quick", port: this.o.port() });
      this.tunnel = tunnel;
      await tunnel.start();
      if (this.tunnel !== tunnel) return this.status();
      this.state = "on";
      tunnel.onExit((error) => {
        if (this.tunnel !== tunnel) return;
        this.tunnel = null;
        this.state = error ? "error" : "off";
        this.error = error ? `Sharing stopped: ${error}` : null;
        this.changed();
      });
    } catch (err) {
      this.tunnel = null;
      this.state = "error";
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.changed();
    return this.status();
  }

  async stop(): Promise<SharingStatus> {
    this.secrets.set("enabled", null);
    await this.stopTunnel();
    this.state = "off";
    this.mode = null;
    this.error = null;
    this.changed();
    return this.status();
  }

  private async stopTunnel(): Promise<void> {
    const t = this.tunnel;
    this.tunnel = null;
    await t?.stop();
  }

  /** Turns sharing back on after a restart if it was on before. */
  resume(): void {
    const mode = this.secrets.get("enabled") as SharingMode | null;
    if (mode && !this.envUrl) void this.start(mode);
  }

  /** A public address for a local frame server (a canvas devserver or app proxy), for viewers on other computers. */
  frameUrl(port: number): Promise<string> {
    const hit = this.frames.get(port);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit.tunnel;
    }
    const entry: { tunnel: Promise<string>; t: Tunnel | null; lastUsed: number } = { tunnel: Promise.resolve(""), t: null, lastUsed: Date.now() };
    entry.tunnel = (async () => {
      const t = this.make(await this.binary(), { kind: "quick", port, hostHeader: `127.0.0.1:${port}` });
      entry.t = t;
      t.onExit(() => this.frames.get(port) === entry && this.frames.delete(port));
      return t.start();
    })();
    entry.tunnel.catch(() => this.frames.get(port) === entry && this.frames.delete(port));
    this.frames.set(port, entry);
    return entry.tunnel;
  }

  /** Closes a frame server's tunnel (its server stopped). */
  closeFrame(port: number): void {
    const entry = this.frames.get(port);
    this.frames.delete(port);
    void entry?.t?.stop();
  }

  private sweep(): void {
    for (const [port, f] of this.frames) if (Date.now() - f.lastUsed > FRAME_IDLE_MS) this.closeFrame(port);
  }

  async stopAll(): Promise<void> {
    clearInterval(this.sweeper);
    const frames = [...this.frames.keys()];
    for (const port of frames) this.closeFrame(port);
    const wasOn = this.tunnel !== null;
    await this.stopTunnel();
    // Shutting down: the address is gone, though sharing stays on for the next start.
    this.state = "off";
    if (wasOn) this.changed();
  }
}
