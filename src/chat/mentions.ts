import type { Queries } from "../core/queries";

export interface Mention {
  kind: "file" | "doc" | "issue";
  ref: string;
}

/** Turns @-mentions into a context block appended to the message. */
export function expandMentions(mentions: Mention[], q: Queries): string {
  if (!mentions.length) return "";
  const parts: string[] = [];
  const files = mentions.filter((m) => m.kind === "file").map((m) => m.ref);
  if (files.length) parts.push(`Files referenced (read them as needed):\n${files.map((f) => `- ${f}`).join("\n")}`);
  for (const m of mentions) {
    if (m.kind === "doc") {
      const doc = q.doc(m.ref);
      if (doc) parts.push(`<doc id="${doc.id}" title="${doc.title}">\n${doc.body}\n</doc>`);
    } else if (m.kind === "issue") {
      const issue = q.issue(m.ref);
      if (issue) parts.push(`<issue key="${issue.key}" title="${issue.title}" stage="${q.stage(issue.stageId)?.name ?? ""}">\n${issue.body}\n</issue>`);
    }
  }
  return parts.length ? `\n\n<context>\n${parts.join("\n\n")}\n</context>` : "";
}
