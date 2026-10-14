import type { Snapshot } from "../../../../core/types";

/** Whether to show first-run setup: kept apart so the app shell does not load the setup screens. */
export function needsOnboarding(snapshot: Snapshot): boolean {
  const me = snapshot.members.find((m) => m.id === snapshot.viewer.memberId);
  if (!me || me.onboardedAt) return false;
  if (snapshot.viewer.role === "owner") return snapshot.projects.length === 0 && snapshot.workspaces.length === 0;
  return true;
}
