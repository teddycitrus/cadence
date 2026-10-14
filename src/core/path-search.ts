import { readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

// Finding programs on PATH without starting `where` or `which`: a process per
// lookup holds up the server (these run while answering requests) and costs
// hundreds of milliseconds each on slow Windows machines. One listing per PATH
// folder answers every lookup, as the shell would.

let listing: { path: string; at: number; programs: Map<string, string> } | null = null;

function currentPath(): string {
  const env = process.env;
  return env[Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"] ?? "";
}

/** Every file name on PATH (lowercased) and where it is; the first folder wins. Reused for 30 seconds or until PATH changes. */
function programs(): Map<string, string> {
  const path = currentPath();
  if (listing && listing.path === path && Date.now() - listing.at < 30_000) return listing.programs;
  const found = new Map<string, string>();
  for (const raw of path.split(delimiter)) {
    const dir = raw.replace(/^"|"$/g, "");
    if (!dir) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), join(dir, name));
  }
  listing = { path, at: Date.now(), programs: found };
  return found;
}

/** Where a program is on PATH, or null. On Windows PATHEXT decides between, say, code.exe and code.cmd. */
export function findOnPath(program: string): string | null {
  const all = programs();
  if (process.platform === "win32") {
    for (const ext of (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)) {
      const hit = all.get((program + ext).toLowerCase());
      if (hit) return hit;
    }
    return null;
  }
  const hit = all.get(program.toLowerCase());
  if (!hit) return null;
  try {
    const st = statSync(hit);
    return st.isFile() && (st.mode & 0o111) !== 0 ? hit : null;
  } catch {
    return null;
  }
}
