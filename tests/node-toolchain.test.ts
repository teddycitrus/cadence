import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installToolchain, tarCommand, toolchainBin } from "../src/projects/node-toolchain";
import { removeTempDir } from "./helpers/temp-dir";

const win = process.platform === "win32";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const name = `node-v24.9.0-${win ? "win" : process.platform === "darwin" ? "darwin" : "linux"}-${arch}`;
const file = `${name}${win ? ".zip" : ".tar.gz"}`;

/** A release archive shaped like the real one, holding a stand-in node binary. */
function fakeRelease(dir: string): Buffer {
  const src = join(dir, "src");
  const bin = win ? join(src, name) : join(src, name, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, win ? "node.exe" : "node"), "stand-in");
  const out = join(dir, file);
  execFileSync(tarCommand(), win ? ["-a", "-cf", out, "-C", src, name] : ["-czf", out, "-C", src, name]);
  return readFileSync(out);
}

function fakeFetch(archive: Buffer, sha = createHash("sha256").update(archive).digest("hex")): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/SHASUMS256.txt")) return new Response(`${"0".repeat(64)}  node-v24.9.0.tar.gz\n${sha}  ${file}\n`);
    if (u.endsWith(`/${file}`)) return new Response(new Uint8Array(archive));
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}

describe("installing Node.js for machines without it", () => {
  const dirs: string[] = [];
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
    for (const d of dirs.splice(0)) removeTempDir(d);
  });
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), "cadence-toolchain-"));
    dirs.push(d);
    return d;
  };

  it("downloads the release for this platform, unpacks it, and puts it first on PATH", async () => {
    const data = temp();
    expect(toolchainBin(data)).toBeNull();
    const version = await installToolchain(data, fakeFetch(fakeRelease(temp())));
    expect(version).toBe("24.9.0");
    const bin = toolchainBin(data)!;
    expect(existsSync(join(bin, win ? "node.exe" : "node"))).toBe(true);
    const path = Object.entries(process.env).find(([k]) => k.toUpperCase() === "PATH")![1]!;
    expect(path.split(delimiter)[0]).toBe(bin);
  });

  it("refuses an archive that does not match its published checksum", async () => {
    const data = temp();
    await expect(installToolchain(data, fakeFetch(fakeRelease(temp()), "f".repeat(64)))).rejects.toThrow(/checksum/);
    expect(toolchainBin(data)).toBeNull();
  });
});
