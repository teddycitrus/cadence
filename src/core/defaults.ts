import type { Settings, StageCategory } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  concurrency: 3,
  defaultModel: "claude-opus-5-5",
  defaultEffort: "high",
  maxTurns: 200,
  systemPrompt: "",
};

export interface StageSeed {
  key: string;
  name: string;
  category: StageCategory;
  color: string;
  humanGate?: boolean;
  hidden?: boolean;
}

// The default workflow. Gated stages are where an agent finishes its step and
// leaves the card for a human to refine and move on.
export const DEFAULT_STAGES: StageSeed[] = [
  { key: "new_idea", name: "Ideas", category: "triage", color: "#a39383" },
  { key: "shaping", name: "Shaping", category: "triage", color: "#8a5a7a", humanGate: true },
  { key: "spec", name: "Plan & Sketch", category: "triage", color: "#5b8a9c", humanGate: true },
  { key: "polish", name: "Design Pass", category: "triage", color: "#c27a86", humanGate: true },
  { key: "ready", name: "Ready to Build", category: "triage", color: "#7f9a5e" },
  { key: "backlog", name: "Backlog", category: "triage", color: "#8a7b6c" },
  { key: "implementation", name: "Building", category: "in_progress", color: "#c49a3a" },
  { key: "pr_review", name: "Code Review", category: "in_review", color: "#5e9690", humanGate: true },
  { key: "qa", name: "QA", category: "in_review", color: "#c8703e", hidden: true },
  { key: "merged", name: "Merged", category: "done", color: "#6d4a7a" },
  { key: "deployed", name: "Deployed", category: "done", color: "#5a7f5b" },
  { key: "duplicate", name: "Duplicate", category: "cancelled", color: "#6e6152" },
  { key: "wont_do", name: "Won't Do", category: "cancelled", color: "#6e6152" },
];

export const DEFAULT_LABELS = [
  { name: "Needs a product call", color: "#b8862e" },
  { name: "From a customer", color: "#a8382a" },
  { name: "Suggested by an agent", color: "#7a4a6e" },
];

export const ISSUE_KEY_PREFIX = "CAD";
