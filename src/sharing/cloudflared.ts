import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { findOnPath } from "../core/path-search";
import { tarCommand } from "../projects/node-toolchain";

// Cloudflare's tunnel client, which gives this computer a public HTTPS address
// without opening a port. One on PATH is used as is; otherwise the current
// release is downloaded from Cloudflare's GitHub releases into Cadence's data
// folder, checked against the SHA-256 GitHub publishes for it.

const run = promisify(execFile);
const RELEASE = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

/** The release asset for this machine: a bare binary, or a .tgz holding one on macOS. */
export function assetName(platform = process.platform, arch = process.arch): string {
  const cpu = arch === "arm64" ? "arm64" : "amd64";
  if (platform === "win32") return "cloudflared-windows-amd64.exe";
  if (platform === "darwin") return `cloudflared-darwin-${cpu}.tgz`;
  return `cloudflared-linux-${cpu}`;
}

const installed = (dir: string) => join(dir, "cloudflared", exe);

/** cloudflared on PATH or installed here before, else null. */
export function findCloudflared(dataDir: string): string | null {
  if (process.env.CADENCE_CLOUDFLARED) return process.env.CADENCE_CLOUDFLARED;
  return findOnPath("cloudflared") ?? (existsSync(installed(dataDir)) ? installed(dataDir) : null);
}

let installing: Promise<string> | null = null;

/** The cloudflared to run, downloading and verifying it on first use. */
export function ensureCloudflared(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const found = findCloudflared(dataDir);
  if (found) return Promise.resolve(found);
  installing ??= (async () => {
    const release = (await (await fetchImpl(RELEASE, { headers: { Accept: "application/vnd.github+json" } })).json()) as { assets?: { name: string; browser_download_url: string; digest?: string | null }[] };
    const asset = release.assets?.find((a) => a.name === assetName());
    if (!asset) throw new Error(`No cloudflared release for ${process.platform} ${process.arch}`);
    const sha = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")?.[1];
    if (!sha) throw new Error("GitHub published no checksum for cloudflared, so it was not installed");
    const res = await fetchImpl(asset.browser_download_url);
    if (!res.ok) throw new Error(`Downloading cloudflared failed (${res.status})`);
    const body = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(body).digest("hex") !== sha) throw new Error("cloudflared did not match its published checksum");
    const dir = join(dataDir, "cloudflared");
    const staging = join(dir, ".staging");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    if (asset.name.endsWith(".tgz")) {
      writeFileSync(join(staging, asset.name), body);
      await run(tarCommand(), ["-xzf", join(staging, asset.name), "-C", staging]);
      const binary = readdirSync(staging).find((f) => f === "cloudflared");
      if (!binary) throw new Error("The cloudflared download had no program in it");
    } else {
      writeFileSync(join(staging, exe), body);
    }
    if (process.platform !== "win32") chmodSync(join(staging, exe), 0o755);
    rmSync(installed(dataDir), { force: true });
    renameSync(join(staging, exe), installed(dataDir));
    rmSync(staging, { recursive: true, force: true });
    return installed(dataDir);
  })().finally(() => (installing = null));
  return installing;
}
