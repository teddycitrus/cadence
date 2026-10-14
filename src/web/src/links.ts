// Links in a workspace (chat replies, pull request badges) can open in that
// workspace's built-in browser instead of a new tab. A per-viewer preference.

const KEY = "cadence.openLinksInside";
export const BROWSE_EVENT = "cadence:browse";

export interface BrowseDetail {
  workspaceId: string;
  url: string;
}

export function openLinksInside(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setOpenLinksInside(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // storage unavailable
  }
}

/**
 * Sends plain clicks on outside links within a workspace (marked with
 * data-workspace-id) to that workspace's browser, when the preference is on.
 */
export function interceptWorkspaceLinks(): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !openLinksInside()) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !/^https?:/i.test(a.href) || new URL(a.href).origin === window.location.origin) return;
    const scope = a.closest("[data-workspace-id]") as HTMLElement | null;
    if (!scope?.dataset.workspaceId) return;
    e.preventDefault();
    window.dispatchEvent(new CustomEvent<BrowseDetail>(BROWSE_EVENT, { detail: { workspaceId: scope.dataset.workspaceId, url: a.href } }));
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
