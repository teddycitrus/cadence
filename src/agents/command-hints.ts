// One-line descriptions of a harness's slash commands, for the composer's suggestions.

/** "Description <args>", trimmed to one short line. */
export function commandHint(description: string, argumentHint?: string | null): string {
  const line = description.split("\n")[0]!.trim().replace(/\s+/g, " ");
  const short = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  return argumentHint?.trim() ? `${short} ${argumentHint.trim()}` : short;
}

/** Hints for the listed command names, from the harness's full command records (aliases included). */
export function hintsOf(commands: { name: string; description: string; argumentHint?: string; aliases?: string[] }[], names: string[]): Record<string, string> {
  const wanted = new Set(names);
  const out: Record<string, string> = {};
  for (const c of commands) {
    if (!c.description) continue;
    for (const n of [c.name, ...(c.aliases ?? [])]) if (wanted.has(n) && !out[n]) out[n] = commandHint(c.description, c.argumentHint);
  }
  return out;
}
