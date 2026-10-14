import { z } from "zod";
import type { Queries } from "../core/queries";
import type { Doc } from "../core/types";
import type { DocCommands } from "../docs/commands";
import type { ShareService } from "../share/service";
import { define, type BoardTool } from "./board-tools";
import { appUrl } from "./tool-context";

/** Words of a query, lowercased, for title matching. */
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A simple relevance score for a title: whole-word hits count most, prefixes next, substrings last. */
function titleScore(title: string, query: string): number {
  const t = words(title);
  const lower = title.toLowerCase();
  let score = lower.includes(query.toLowerCase().trim()) ? 3 : 0;
  for (const w of words(query)) {
    if (t.includes(w)) score += 2;
    else if (t.some((x) => x.startsWith(w))) score += 1;
    else if (lower.includes(w)) score += 0.5;
  }
  return score;
}

/** Docs tools beyond read/create/edit: search, grep, tree, move, delete, history, sharing. */
export function docTools(q: Queries, docs: DocCommands, shares: ShareService): BoardTool[] {
  const children = (parentId: string | null) => q.docs().filter((d) => d.parentId === parentId).sort((a, b) => a.position - b.position);
  const path = (d: Doc): Doc[] => {
    const chain: Doc[] = [];
    for (let p: Doc | null = d; p; p = p.parentId ? q.doc(p.parentId) : null) chain.unshift(p);
    return chain;
  };
  return [
    define({
      name: "docs_search",
      description: "Find docs by TITLE (ranked). For docs that mention something in their text, use docs_grep.",
      shape: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
      run: (a) => {
        const hits = q
          .docs()
          .map((d) => ({ d, s: titleScore(d.title, a.query) }))
          .filter((x) => x.s > 0)
          .sort((x, y) => y.s - x.s || y.d.updatedAt.localeCompare(x.d.updatedAt))
          .slice(0, a.limit ?? 10);
        return hits.map(({ d }) => `- ${d.title} (id ${d.id}; ${path(d).map((p) => p.title).join(" / ")})`).join("\n") || "No docs with a matching title.";
      },
    }),
    define({
      name: "docs_grep",
      description: "Search doc BODIES for a regular expression (or literal text with literal: true). Returns matching lines with line numbers and a line of context on each side.",
      shape: { pattern: z.string().min(1).max(200), literal: z.boolean().optional(), case_sensitive: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
      run: (a) => {
        let re: RegExp;
        try {
          re = new RegExp(a.literal ? a.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : a.pattern, a.case_sensitive ? "" : "i");
        } catch (err) {
          throw new Error(`Bad pattern: ${err instanceof Error ? err.message : String(err)}`);
        }
        const out: string[] = [];
        const limit = a.limit ?? 50;
        for (const d of q.docs()) {
          const lines = d.body.split("\n");
          lines.forEach((l, n) => {
            if (out.length >= limit || !re.test(l)) return;
            const ctx = [n - 1, n, n + 1].filter((k) => k >= 0 && k < lines.length).map((k) => `${k === n ? ">" : " "} ${k + 1}: ${lines[k]}`);
            out.push(`${d.title} (id ${d.id})\n${ctx.join("\n")}`);
          });
          if (out.length >= limit) break;
        }
        return out.join("\n\n") || "No matches.";
      },
    }),
    define({
      name: "docs_tree",
      description: "The doc tree from a parent (the top when omitted), to a depth, with ids and child counts.",
      shape: { parent: z.string().optional(), depth: z.number().int().min(1).max(10).optional() },
      run: (a) => {
        if (a.parent) docs.docOrThrow(a.parent);
        const out: string[] = [];
        const walk = (parentId: string | null, depth: number, indent: string) => {
          for (const d of children(parentId)) {
            const kids = children(d.id).length;
            out.push(`${indent}- ${d.icon ? `${d.icon} ` : ""}${d.title} (id ${d.id}${kids ? `, ${kids} sub-pages` : ""})`);
            if (depth > 1) walk(d.id, depth - 1, `${indent}  `);
          }
        };
        walk(a.parent ?? null, a.depth ?? 3, "");
        return out.join("\n") || "No docs.";
      },
    }),
    define({
      name: "docs_path",
      description: "A doc's ancestors from the top down to the doc itself.",
      shape: { doc: z.string() },
      run: (a) => path(docs.docOrThrow(a.doc)).map((d) => `${d.title} (id ${d.id})`).join(" / "),
    }),
    define({
      name: "docs_summary",
      description: "Totals for the doc tree: how many docs, the deepest nesting, how many have sub-pages, and the ten most recently updated.",
      shape: {},
      run: () => {
        const all = q.docs();
        const depth = Math.max(0, ...all.map((d) => path(d).length));
        const folders = all.filter((d) => all.some((c) => c.parentId === d.id)).length;
        const recent = [...all].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, 10).map((d) => `- ${d.title} (id ${d.id}, ${d.updatedAt.slice(0, 16).replace("T", " ")})`);
        return `${all.length} docs, max depth ${depth}, ${folders} with sub-pages.\nRecently updated:\n${recent.join("\n") || "- none"}`;
      },
    }),
    define({
      name: "docs_move",
      description: "Move a doc under another doc (or to the top level with parent null), at a position among its new siblings (0 is first; the end when omitted).",
      shape: { doc: z.string(), parent: z.string().nullable(), position: z.number().int().min(0).optional() },
      run: (a, ctx) => {
        docs.move(a.doc, a.parent, a.position ?? Number.MAX_SAFE_INTEGER, ctx.actor);
        return "Moved.";
      },
    }),
    define({
      name: "docs_delete",
      description: "Delete a doc and all its sub-pages. Ask the person first. Set confirm: true to proceed. Old versions stay in the history.",
      shape: { doc: z.string(), confirm: z.literal(true) },
      run: (a, ctx) => {
        const d = docs.docOrThrow(a.doc);
        const count = q.docs().filter((x) => path(x).some((p) => p.id === d.id)).length;
        docs.delete(d.id, ctx.actor);
        return `Deleted ${d.title}${count > 1 ? ` and ${count - 1} sub-pages` : ""}.`;
      },
    }),
    define({
      name: "docs_history",
      description: "A doc's saved versions, newest first, with who saved each. Pass a version to read that version's markdown.",
      shape: { doc: z.string(), version: z.number().int().min(1).optional() },
      run: (a) => {
        const versions = docs.history(a.doc);
        if (a.version) {
          const v = versions.find((x) => x.version === a.version);
          if (!v) throw new Error(`Version ${a.version} not found`);
          return `# ${v.title}\n\n${v.body}`;
        }
        return versions.slice(0, 50).map((v) => `- v${v.version} ${v.ts.slice(0, 16).replace("T", " ")} by ${v.actor}: ${v.title}`).join("\n");
      },
    }),
    define({
      name: "docs_restore",
      description: "Bring back an earlier version of a doc (it becomes a new version, so nothing is lost).",
      shape: { doc: z.string(), version: z.number().int().min(1) },
      run: (a, ctx) => `Restored version ${a.version}; the doc is now at version ${docs.restore(a.doc, a.version, ctx.actor).version}.`,
    }),
    define({
      name: "docs_share_link",
      description: "A link to a doc. By default the member link (teammates sign in). With public: true, a read-only link anyone can open; only when the person asks.",
      shape: { doc: z.string(), public: z.boolean().optional() },
      run: (a, ctx) => {
        const d = docs.docOrThrow(a.doc);
        return a.public ? appUrl(`/share/${shares.create("doc", d.id, ctx.actor).id}`) : appUrl(`/docs/${d.id}`);
      },
    }),
  ];
}
