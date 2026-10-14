import { designToolPrompt } from "../canvas/design-tools";
import { starterTaskPrompt } from "../projects/starter-tasks";
import { starterPrompt } from "../projects/templates";

/** A workflow that ships with Cadence: run it in any chat with /name, or an agent reads it with skill_get. */
export interface BuiltinSkill {
  name: string;
  title: string;
  description: string;
  argumentHint: string;
  /** The instructions, given what the person typed after the command. */
  body: (args: string) => string;
}

const join = (...parts: (string | false | null | undefined)[]) => parts.filter((p): p is string => typeof p === "string").join("\n");
const notes = (args: string) => (args.trim() ? `\nWhat the person asked for: ${args.trim()}` : "");

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "first-run",
    title: "Guided first run",
    description: "Walk a newcomer through the whole Cadence loop on their own project: issue, spec, design, code, pull request.",
    argumentHint: "[a small feature to use as the example]",
    body: (args) =>
      join(
        "Give the person a guided tour of Cadence by doing one small, real piece of work with them, end to end. Explain each step in a sentence before you do it, and stop for their go-ahead between steps.",
        "",
        "1. Issue: agree on a small, useful change to this project (suggest two or three if they have none). File it with issues_create in the first stage and show them the board.",
        "2. Spec: write a short PRD as a doc linked to the issue (problem, scope, acceptance criteria, open questions). Ask them to read it and adjust.",
        "3. Design: if it touches UI, add frames for the new states to a canvas next to the existing screens (canvas_guide first). Show a screenshot.",
        "4. Code: implement it on this workspace's branch, with a test. Run the project's checks.",
        "5. Pull request: commit, open it with pr_open, link it to the issue, and move the issue to review.",
        "6. Close by pointing at what they can automate next: an agent for this stage (Agents), triggers, and the sign-off stages.",
        notes(args),
      ),
  },
  {
    name: "plan-feature",
    title: "Plan and sketch a feature",
    description: "One backlog issue into a PRD in Docs and a clickable canvas built from the project's real components, both linked to the issue.",
    argumentHint: "[issue key or feature]",
    body: (args) => starterTaskPrompt("plan-feature", args),
  },
  {
    name: "design-feature",
    title: "Design a feature from start to finish",
    description: "Settle the open UX decisions with the person, then build every screen and state as clickable frames from real components that follow the design system.",
    argumentHint: "<feature to design>",
    body: (args) =>
      join(
        "Design this feature completely as frames on a canvas.",
        "",
        "1. Understand: read the issue or request, the related docs, and the existing screens and design system (canvas_list, the design-system canvases, the shared components). Note which decisions are already made.",
        "2. Align: where the UX is genuinely ambiguous (layout model, navigation, what happens on errors, empty and loading states, permissions), ask the person a short list of concrete questions, each with two or three options and your recommendation. Wait for answers; do not ask about things you can decide from the existing product.",
        "3. Plan the frames: every screen and every state a user can reach (empty, loading, error, success, long content, small screen). List them before building.",
        "4. Build: UI-only components in the app's source (no business logic, in-memory data), composed from the existing components and tokens. One frame per state, laid out in reading order (canvas_layout). Bracket the work with canvas_start_working and canvas_finish_working.",
        "5. Check: canvas_validate, screenshot each frame, and fix anything off against the design system. Link the canvas to the issue and summarize the decisions in a short doc.",
        notes(args),
      ),
  },
  {
    name: "design-options",
    title: "Explore design directions",
    description: "A one-shot exploration: several distinct, polished HTML design directions for an idea, side by side on a canvas.",
    argumentHint: "<idea>",
    body: (args) =>
      join(
        "Explore this idea as three to four clearly different design directions, each a polished static HTML page.",
        "",
        "- Make the directions differ in layout and tone, not only in color: for example dense and utilitarian, editorial, playful, and premium. Name each direction and state its intent in one line at the top of the file.",
        "- Each is self-contained HTML and CSS in designs/<idea-slug>/<direction>.html, with real copy, a deliberate type scale and palette, and no external scripts.",
        "- Add an html frame for each to a canvas (desktop frame, plus a mobile frame for the strongest one), side by side.",
        "- Screenshot them, fix what looks unfinished, and reply with a two-line pitch per direction and which you would pick.",
        notes(args),
      ),
  },
  {
    name: "build-prototype",
    title: "Build a working prototype",
    description: "Scaffold and build a working Vite + React + Tailwind prototype of an idea, with frames for its screens.",
    argumentHint: "<idea>",
    body: (args) =>
      join(
        "If this workspace is not already a Vite + React + Tailwind app, scaffold one first (npm create vite@latest with the react-ts template, then add Tailwind), install it, and add src/app.canvas.tsx with a route frame for /.",
        "",
        starterPrompt("prototype", args || "the idea the person describes"),
      ),
  },
  {
    name: "map-components",
    title: "Map the component library",
    description: "Scan the codebase and build design-system canvases per component family, plus frames for the design debt it finds.",
    argumentHint: "[notes]",
    body: (args) => designToolPrompt("generate", args),
  },
  {
    name: "map-flows",
    title: "Map the product's user flows",
    description: "Explore the running app and capture its three main user journeys as full-screen frames, with an overview of which screens are reused.",
    argumentHint: "[app URL or areas to focus on]",
    body: (args) =>
      join(
        "Map how people actually use this app.",
        "",
        "1. Start the app (the canvas's appCommand, or the project's dev command) and open it with browser_open. Click through it with the browser tools to find the three journeys that matter most (for example sign up, the core task, settings or billing). Ask the person if it is unclear which three.",
        "2. For each journey, list its steps. For each step add a full-screen route frame (1440x900 desktop) to a canvas named after the journey, in order left to right. When a step is a state a route alone cannot reach (a filled form, an open dialog), recreate it as a component frame from the app's real components with the right props.",
        "3. Add an overview canvas: one row per journey with small frames, and a note on each frame saying whether it is a live route or a recreated state.",
        "4. Screenshot one frame per journey, fix blank or broken frames (canvas_debug once if needed), and reply with the journeys and anything that looked broken in the app.",
        notes(args),
      ),
  },
  {
    name: "page-to-frame",
    title: "Turn a page into an editable frame",
    description: "Rebuild a route or HTML frame as a faithful React frame made of plain JSX and scoped CSS, so it can be edited on the canvas.",
    argumentHint: "<canvas path and frame>",
    body: (args) =>
      join(
        "Recreate the given frame (a live route or an HTML page) as a React component frame that looks the same at its frame size and can be edited element by element.",
        "",
        "1. Capture the source: screenshot it, and freeze it with the frame's Freeze as HTML if it is a route, so you work from its exact markup and computed styles.",
        "2. Write one component in the app's source (a designs/ or prototypes/ folder) using plain HTML and SVG elements in JSX, with a CSS module or a scoped class prefix for styles. Keep real text, image URLs, and icons; drop scripts, tracking, and anything invisible.",
        "3. Add a component frame rendering it next to the original, same frame size.",
        "4. Compare screenshots side by side and fix differences in layout, spacing, fonts, and colors until they match closely. Use design tokens where the values match them.",
        "5. Reply with what was simplified and anything that could not be reproduced.",
        notes(args),
      ),
  },
  {
    name: "start-agents",
    title: "Put agents on the backlog",
    description: "Find where tickets and feedback live, bring the three easiest issues onto the board, and put agents on them.",
    argumentHint: "[where to look]",
    body: (args) => starterTaskPrompt("start-agents", args),
  },
  {
    name: "check-tests",
    title: "Check tests and CI",
    description: "Whether a repository is ready for agents to ship: CI gates, test quality, releases, and error tracking, as a rated table in a doc.",
    argumentHint: "[repos or notes]",
    body: (args) => starterTaskPrompt("check-ci", args),
  },
  {
    name: "find-design-drift",
    title: "Find design drift",
    description: "Sweep the code for colors and sizes off the tokens, hand-rolled copies of blessed components, and deprecated patterns.",
    argumentHint: "[notes]",
    body: (args) => designToolPrompt("audit", args),
  },
  {
    name: "review-design",
    title: "Review the UI changes",
    description: "Review a change on two tracks: adherence to the design system, and a designer's judgment of the rendered frames.",
    argumentHint: "[branch or pull request]",
    body: (args) => designToolPrompt("review", args),
  },
  {
    name: "tighten-components",
    title: "Tighten the component library",
    description: "Make violations harder to write by tightening the design-system components themselves; proposes every change before applying it.",
    argumentHint: "[components]",
    body: (args) => designToolPrompt("harden", args),
  },
  {
    name: "pre-handoff-check",
    title: "Check a design change before handoff",
    description: "Verify a designer's diff only touches design and UI, with no business logic they cannot vouch for, and draft the handoff note for engineers.",
    argumentHint: "[branch]",
    body: (args) =>
      join(
        "Check this branch's diff (against its base) before a designer hands it to engineering.",
        "",
        "1. Classify every changed file and hunk: canvas or frame, styling, markup or component structure, copy, or behavior (state, data fetching, routing, API calls, validation, permissions, build or config).",
        "2. Anything in the behavior group is out of scope for a design change. For each, say what it does and whether it should be reverted, moved to its own issue, or kept with an engineer's review. Do not change code without asking.",
        "3. Check the UI parts for hardcoded values that should be tokens and for components duplicated instead of reused.",
        "4. Draft a handoff note as a doc: what changed visually (with frame links and screenshots), which files, what an engineer needs to wire up, and open questions.",
        notes(args),
      ),
  },
  {
    name: "polish-pr",
    title: "Tidy a pull request for review",
    description: "Turn a design branch into a clean pull request reviewers can judge visually: tidy commits, before and after images, linked canvases.",
    argumentHint: "[branch or issue]",
    body: (args) =>
      join(
        "Prepare this branch's pull request so a reviewer can understand it without running anything.",
        "",
        "1. Make sure the work is committed with clear messages, nothing unrelated is included (run canvas-code-quality's checks if behavior changed), and the project's checks pass.",
        "2. Run the visual checks for the changed frames (canvas_check_visuals) and post them to the pull request (canvas_post_visuals_to_pr).",
        "3. Write the description: the problem in one line, what changed for users, before and after screenshots of the key frames, links to the canvases and the issue, and what to look at closely.",
        "4. Open it with pr_open (or update the open one) and move the issue to review.",
        notes(args),
      ),
  },
  {
    name: "save-design-taste",
    title: "Record design preferences",
    description: "Look back over this conversation and write the design preferences the person approved into the project's agent instructions, so future design work follows them.",
    argumentHint: "[anything to emphasize]",
    body: (args) =>
      join(
        "Review this conversation for design decisions the person approved or corrected: layout patterns, spacing and density, type, color use, component choices, copy tone, and things they disliked.",
        "",
        "1. List them back as short, concrete rules (\"Primary actions sit bottom right of dialogs\", not \"good layouts\") and ask the person to confirm or edit the list.",
        "2. Write the confirmed rules into the project's agent instructions: a Design preferences section in AGENTS.md (create it if missing) and the same in CLAUDE.md if the project has one. Merge with rules already there instead of duplicating; keep each rule one line.",
        "3. Commit the change and reply with the final list.",
        notes(args),
      ),
  },
];

export function builtinSkill(name: string): BuiltinSkill | null {
  const n = name.replace(/^\//, "").toLowerCase();
  return BUILTIN_SKILLS.find((s) => s.name === n) ?? null;
}

/**
 * A message that starts with a built-in skill's slash command becomes that
 * workflow's instructions (what follows the command is its argument). Anything
 * else passes through unchanged.
 */
export function expandSkillCommand(text: string): string {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const skill = m ? builtinSkill(m[1]!) : null;
  if (!skill) return text;
  return `Run the Cadence workflow "${skill.title}" (/${skill.name}).\n\n${skill.body(m![2] ?? "")}`;
}
