/** A stretch of a unified diff: lines to show, or unchanged lines folded away. */
export type DiffPart = { kind: "lines"; start: number; lines: string[] } | { kind: "fold"; start: number; lines: string[] };

const isContext = (line: string) => !line.startsWith("+") && !line.startsWith("-") && !line.startsWith("@@") && !line.startsWith("\\");

/**
 * Splits a diff so long runs of unchanged lines can collapse. A run folds only
 * when hiding it saves more than `min` lines; `keep` lines stay visible on each
 * side of a change.
 */
export function foldDiff(diff: string, keep = 3, min = 4): DiffPart[] {
  const lines = diff.split("\n");
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], start: number, chunk: string[]) => {
    if (!chunk.length) return;
    const last = parts.at(-1);
    if (last && last.kind === kind) last.lines.push(...chunk);
    else parts.push({ kind, start, lines: chunk });
  };
  let i = 0;
  while (i < lines.length) {
    if (!isContext(lines[i]!)) {
      push("lines", i, [lines[i]!]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && isContext(lines[j]!)) j++;
    const head = i === 0 ? 0 : keep;
    const tail = j === lines.length ? 0 : keep;
    const hidden = j - i - head - tail;
    if (hidden > min) {
      push("lines", i, lines.slice(i, i + head));
      push("fold", i + head, lines.slice(i + head, j - tail));
      push("lines", j - tail, lines.slice(j - tail, j));
    } else {
      push("lines", i, lines.slice(i, j));
    }
    i = j;
  }
  return parts;
}
