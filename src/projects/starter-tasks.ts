// The first agents a new team can start from onboarding. Each runs in its own
// workspace. Written for Cadence; estimates are rough and shown to people.

export const STARTER_TASKS = ["plan-feature", "component-map", "check-ci", "start-agents"] as const;
export type StarterTask = (typeof STARTER_TASKS)[number];

export interface StarterTaskInfo {
  id: StarterTask;
  title: string;
  description: string;
  minutes: number;
  tokens: string;
  /** Whether the person describes something first (the feature to spec). */
  needsNote: boolean;
}

export const STARTER_TASK_INFO: StarterTaskInfo[] = [
  { id: "plan-feature", title: "Plan and sketch a feature", description: "A written plan in Docs and a clickable canvas made from your own components, tied to an issue.", minutes: 12, tokens: "~150k", needsNote: true },
  { id: "component-map", title: "Map your component library", description: "A canvas for each group of components in your code, plus the inconsistencies it turns up.", minutes: 20, tokens: "~300k", needsNote: false },
  { id: "check-ci", title: "Check my tests and CI", description: "How ready your repo is for agents to deliver changes: CI checks, test quality, releases, error tracking.", minutes: 10, tokens: "~120k", needsNote: false },
  { id: "start-agents", title: "Put agents on your backlog", description: "Finds where your tickets and feedback live, brings the three easiest issues onto the board, and assigns agents to them.", minutes: 8, tokens: "~80k", needsNote: false },
];

export function starterTaskPrompt(task: StarterTask, note: string): string {
  const extra = note.trim() ? ["", `Notes from the person who started this: ${note.trim()}`] : [];
  switch (task) {
    case "plan-feature":
      return [
        `Spec and design this feature: ${note.trim() || "(ask me which feature)"}`,
        "",
        "1. Read the code that the feature touches and any related issues and docs (issues_list, docs_list). Ask me anything that would change the design before going further, then wait for the answer.",
        "2. Create an issue for it if there is none (issues_create), and write a PRD in Docs linked to that issue: the problem, who it is for, the flows, every state (empty, loading, error, edge cases), and what is out of scope.",
        "3. Build a canvas from the project's real components with one frame per screen and state (canvas_create). Check each with canvas_screenshot, and embed the canvas in the PRD.",
        "4. Do not build the feature. Commit the canvas and reply with links to the issue and the PRD.",
      ].join("\n");
    case "component-map":
      return [
        "Assemble this project's design system as canvases.",
        "",
        "1. Survey the codebase: tokens (colors, type, spacing, radii, shadows), and every reusable component, grouped into families (foundations, inputs, buttons, navigation, feedback, layout, data display, overlays).",
        "2. Create one canvas per family (canvas_create) with a frame per component showing its variants and states, rendered from the real components. Start with a Foundations canvas showing the tokens. Read canvas_guide first.",
        "   In each family canvas's default export, set library: \"Design System\" and declare every top-level component it shows under assets, with a usage note (what it is for, and when not to use it) and its real variants as prop sets. Sub-parts stay with their parent. Check the result with assets_list.",
        "3. Note design debt as you go: one-off colors and sizes, near-duplicate components, inconsistent states. Put each finding on a frame in a Design debt canvas that shows the inconsistency side by side.",
        "4. Check every frame with canvas_screenshot, commit, and write a short Design system doc linking the canvases and listing the debt by priority.",
        ...extra,
      ].join("\n");
    case "check-ci":
      return [
        "Audit whether this repository is ready for agents to ship changes safely.",
        "",
        "Check and rate each area green, yellow, or red with one line of evidence:",
        "- CI: does every pull request run build, typecheck, lint, and tests? Are checks required before merging?",
        "- Tests: how much of the code is covered, are the tests meaningful (not snapshots of nothing), how long do they take, any flaky ones?",
        "- Releases: how does code reach staging and production, is it automated, can it be rolled back?",
        "- Error tracking: are runtime errors reported somewhere agents could read?",
        "- Local setup: can a fresh checkout install, build, and test with documented commands?",
        "",
        "Write the result as a doc titled \"CI and test audit\" with a table (area, rating, evidence, fix) and the three highest-value fixes first. File an issue for each red item. Do not change the code.",
        ...extra,
      ].join("\n");
    case "start-agents":
      return [
        "Get this team's agent pipeline running.",
        "",
        "1. Find where work and feedback live: connected integrations (Linear, Slack, GitHub issues), any TODO or issue files in the repo, and the board itself. Tell me what you found.",
        "2. Pick the three lowest-hanging issues: small, clear, low risk, and valuable. Bring each onto the board in the right stage with a crisp description (issues_create, or update the synced one).",
        "3. Look at the agents (agents_list). Where an issue fits an enabled agent, assign it; where no agent fits, create one from a template (agents_templates, agents_create) and tell me to review and enable it.",
        "4. Reply with the three issues, who is on each, and what I need to approve.",
        ...extra,
      ].join("\n");
  }
}
