import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The first-run tour: a "Welcome" workspace whose chat explains Cadence and
// points at a canvas of what it can do, opened beside the chat.

export const WELCOME_CANVAS_PATH = "cadence/welcome.canvas.tsx";

export const WELCOME_QUESTION = "What is a Cadence workspace, and what can I do here?";

export const WELCOME_ANSWER = [
  "Each workspace is its own copy of your code on its own git branch, in a separate worktree, so several pieces of work (yours and your agents') never step on each other.",
  "",
  "In a workspace you can chat with an agent that edits the code, run the app and your scripts with the Run button, look at canvases of your real components, review the changes, and open a pull request.",
  "",
  "Around the workspaces there is the board (issues moving through stages with sign-off stages), agents that pick up issues on their own, docs for specs and plans, and integrations with GitHub, Slack, and Linear.",
  "",
  `**Try it now:** the canvas beside this chat (\`${WELCOME_CANVAS_PATH}\`) walks through each part. Ask me anything about Cadence here.`,
].join("\n");

interface Card {
  id: string;
  title: string;
  body: string;
  points: string[];
  color: string;
}

const CARDS: Card[] = [
  { id: "Board", title: "1. The board", color: "#6a762e", body: "Feedback becomes issues that move through stages, from triage to merged.", points: ["Stages are yours to rename and reorder", "Sign-off stages: agents never move a card out of one", "Saved views, filters, and manual ordering"] },
  { id: "Agents", title: "2. Agents", color: "#49788a", body: "Agents with their own instructions pick up work when something happens.", points: ["Triggers: assigned, stage moves, labels, schedules, webhooks, GitHub, Slack", "Templates for triage, specs, building, review, and releases", "Budgets and a run queue keep them in check"] },
  { id: "Chat", title: "3. Workspaces and chat", color: "#577d58", body: "Every piece of work gets a branch, a worktree, and chats with an agent.", points: ["Plan mode, permission prompts, and steering mid-turn", "Built-in workflows: type / to see them", "Terminals, files, the built-in browser, and the Run button"] },
  { id: "Docs", title: "4. Docs", color: "#a5781d", body: "Specs and plans next to the work, edited together live.", points: ["Markdown with diagrams and embedded canvases", "History and restore", "Generate canvases from a spec"] },
  { id: "Canvases", title: "5. Canvases", color: "#b5606f", body: "Your real components and routes, laid out as frames.", points: ["Select an element and restyle it; the change is written to source", "Assets: the design system as insertable building blocks", "Visual checks against baselines, on every pull request"] },
  { id: "Ship", title: "6. Review and ship", color: "#4e8a84", body: "A full git client, pull requests with checks and reviews, and visual check in CI.", points: ["Hunk staging, AI commit messages, commit and sync", "Pull request status and review state on the issue", "cadence-mcp brings all of this to any agent"] },
];

/** The tour canvas: plain JSX with inline styles, so it renders in any project. */
export function welcomeCanvasSource(): string {
  const story = (c: Card, i: number) => `export const ${c.id} = {
  name: ${JSON.stringify(c.title)},
  render: () => (
    <div style={{ minHeight: "100vh", boxSizing: "border-box", padding: 40, background: "#efe2c9", color: "#4b2434", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: 48, height: 6, borderRadius: 3, background: ${JSON.stringify(c.color)}, marginBottom: 24 }} />
      <h1 style={{ fontSize: 34, fontWeight: 500, letterSpacing: "-0.01em", fontFamily: "Newsreader, Georgia, 'Iowan Old Style', serif", margin: "0 0 12px" }}>${c.title}</h1>
      <p style={{ fontSize: 17, lineHeight: 1.5, color: "#775858", margin: "0 0 24px" }}>${c.body}</p>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 15, lineHeight: 1.9 }}>
${c.points.map((p) => `        <li>${p}</li>`).join("\n")}
      </ul>
    </div>
  ),
  frame: { x: ${(i % 3) * 600}, y: ${Math.floor(i / 3) * 480}, width: 520, height: 400 },
};`;
  return [`// The Cadence tour. Delete this file whenever you like.`, ``, `export default { name: "Welcome to Cadence", background: "#d7c09b" };`, ``, CARDS.map(story).join("\n\n"), ``].join("\n");
}

/** Writes the tour canvas into a workspace folder unless it is already there. */
export function writeWelcomeCanvas(root: string): string {
  const file = join(root, WELCOME_CANVAS_PATH);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, welcomeCanvasSource());
  }
  return WELCOME_CANVAS_PATH;
}
