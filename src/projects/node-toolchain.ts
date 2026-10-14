import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

// A Node.js that Cadence installs for people who do not have one: the official
// release for this machine, checked against its published SHA-256, kept in
// Cadence's data folder and put first on PATH for everything Cadence starts
// (terminals, dev servers, agents, builds).

const run = promisify(execFile);
const LINE = "latest-v24.x";
const DIST = `https://nodejs.org/dist/${LINE}`;

/** The release archive name for this platform, like node-v24.1.0-win-x64.zip. */
function archiveSuffix(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") return `-win-${arch}.zip`;
  if (process.platform === "darwin") return `-darwin-${arch}.tar.gz`;
  return `-linux-${arch}.tar.gz`;
}

/**
 * Windows 10 and later ship bsdtar, which reads zip files; it is named by full path because a
 * GNU tar from Git or MSYS earlier on PATH reads "C:" as a remote host and cannot open zips.
 */
export function tarCommand(): string {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

const root = (dataDir: string) => join(dataDir, "toolchain");

/** The folder holding node (and npm, npx) once installed, or null. */
export function toolchainBin(dataDir: string): string | null {
  const dir = root(dataDir);
  if (!existsSync(dir)) return null;
  const release = readdirSync(dir).filter((d) => d.startsWith("node-v")).sort().pop();
  if (!release) return null;
  const bin = process.platform === "win32" ? join(dir, release) : join(dir, release, "bin");
  return existsSync(join(bin, process.platform === "win32" ? "node.exe" : "node")) ? bin : null;
}

/** Puts an installed toolchain first on this process's PATH, so every child inherits it. */
export function useToolchain(dataDir: string): boolean {
  const bin = toolchainBin(dataDir);
  if (!bin) return false;
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const parts = (process.env[key] ?? "").split(delimiter);
  if (!parts.includes(bin)) process.env[key] = [bin, ...parts].join(delimiter);
  return true;
}

let installing: Promise<string> | null = null;

/** Downloads, verifies, and unpacks the current Node 24 release. Resolves to its version. */
export function installToolchain(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  installing ??= (async () => {
    const sums = await (await fetchImpl(`${DIST}/SHASUMS256.txt`)).text();
    const suffix = archiveSuffix();
    const entry = sums.split("\n").map((l) => l.trim().split(/\s+/)).find(([, name]) => /^node-v\d+\.\d+\.\d+/.test(name ?? "") && name!.endsWith(suffix));
    if (!entry) throw new Error(`No Node.js release for ${process.platform} ${process.arch}`);
    const [sha, name] = entry as [string, string];
    const res = await fetchImpl(`${DIST}/${name}`);
    if (!res.ok) throw new Error(`Downloading ${name} failed (${res.status})`);
    const body = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(body).digest("hex") !== sha) throw new Error(`${name} did not match its published checksum`);
    const dir = root(dataDir);
    const staging = join(dir, ".staging");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const archive = join(staging, name);
    writeFileSync(archive, body);
    await run(tarCommand(), ["-xf", archive, "-C", staging], { windowsHide: true });
    const unpacked = readdirSync(staging).find((d) => d.startsWith("node-v") && !d.endsWith(".zip") && !d.endsWith(".tar.gz"));
    if (!unpacked) throw new Error(`${name} did not unpack`);
    for (const old of readdirSync(dir).filter((d) => d.startsWith("node-v"))) rmSync(join(dir, old), { recursive: true, force: true });
    renameSync(join(staging, unpacked), join(dir, unpacked));
    rmSync(staging, { recursive: true, force: true });
    useToolchain(dataDir);
    return /v(\d+\.\d+\.\d+)/.exec(unpacked)?.[1] ?? unpacked;
  })().finally(() => (installing = null));
  return installing;
}
