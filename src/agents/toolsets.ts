import type { BoardTool } from "./board-tools";

/** Groups of tools an outside agent can ask for (`?toolsets=issues,docs`). */
export const TOOLSETS = ["issues", "docs", "comments", "agents", "scripts", "slack", "linear", "canvas", "skills", "browser", "git", "host"] as const;
export type Toolset = (typeof TOOLSETS)[number];

export function toolsetOf(name: string): Toolset | null {
  if (/^(issues|labels|views)_|^members_list$|^board_overview$/.test(name)) return "issues";
  if (name.startsWith("docs_")) return "docs";
  if (name.startsWith("comments_") || name === "canvas_comments" || name === "canvas_reply") return "comments";
  if (name.startsWith("agents_")) return "agents";
  if (name.startsWith("scripts_")) return "scripts";
  if (name.startsWith("slack_")) return "slack";
  if (name.startsWith("linear_")) return "linear";
  if (/^(canvas|design|assets?|visual_review)_/.test(name)) return "canvas";
  if (name.startsWith("skill_")) return "skills";
  if (name.startsWith("browser_")) return "browser";
  if (/^(pr|git)_/.test(name) || name === "report_findings") return "git";
  if (name.startsWith("cadence_")) return "host";
  return null;
}

/**
 * Tools that only read. Everything else may change something (including
 * share links, which mint a link), so a read-only connection leaves it out.
 */
const READ_ONLY = new RegExp(
  [
    "^board_overview$",
    "_(list|get|search|grep|tree|path|summary|activity|links|inbox|threads|history|status|report|templates|template_get|list_runs|list_assignable|trigger_setup|find_my_work|suggest_stage|board_summary|lifecycle_report|pr_report|canvas_activity|list_users|list_channels|permalink)$",
    "^(slack_read_|linear_get|linear_search|canvas_screenshot|canvas_check_visuals|canvas_validate|canvas_debug|canvas_layout|canvas_guide|canvas_verify_visual|design_context|assets_list|assets_get|browser_read|browser_screenshot|browser_console|browser_elements|cadence_whoami|cadence_list|visual_review_doctor)",
    "^(docs_get|issues_get|agents_get|skill_get|skill_list)$",
  ].join("|"),
);

export const isReadOnly = (name: string) => READ_ONLY.test(name);

export interface ToolFilter {
  toolsets?: readonly string[] | null;
  readonly?: boolean;
}

/** The tools a connection asked for. Unknown toolset names are ignored; tools outside every set stay with the full surface only. */
export function filterTools(tools: BoardTool[], f: ToolFilter): BoardTool[] {
  const wanted = f.toolsets?.length ? new Set(f.toolsets.map((s) => s.trim().toLowerCase())) : null;
  return tools.filter((t) => (!wanted || wanted.has(toolsetOf(t.name) ?? "")) && (!f.readonly || isReadOnly(t.name)));
}

/** Parses `issues,docs` (or repeated params) into toolset names. */
export function parseToolsets(raw: unknown): string[] | null {
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (typeof v === "string" ? v.split(",") : [])).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.length ? parts : null;
}
