// Context handed to a workspace's chat composer from elsewhere (a canvas
// selection): the next composer for that workspace starts with it.

export const COMPOSER_CONTEXT_EVENT = "cadence:composer-context";
const pending = new Map<string, string>();

export function addComposerContext(workspaceId: string, text: string): void {
  pending.set(workspaceId, `${pending.get(workspaceId) ?? ""}${text}`);
  window.dispatchEvent(new CustomEvent<string>(COMPOSER_CONTEXT_EVENT, { detail: workspaceId }));
}

/** Takes what is waiting for this workspace's composer (once). */
export function takeComposerContext(workspaceId: string): string {
  const text = pending.get(workspaceId) ?? "";
  pending.delete(workspaceId);
  return text;
}
