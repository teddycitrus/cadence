// App-wide layout toggles and their keyboard shortcuts. Per-viewer, so they
// live in this browser.

const SIDEBAR_KEY = "cadence.sidebar";
/** Workspace views listen for this to show or hide their side panel. */
export const RIGHT_PANEL_EVENT = "cadence:toggle-right-panel";

export function sidebarVisible(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "hidden";
  } catch {
    return true;
  }
}

export function setSidebarVisible(on: boolean): void {
  document.documentElement.dataset.sidebar = on ? "shown" : "hidden";
  try {
    localStorage.setItem(SIDEBAR_KEY, on ? "shown" : "hidden");
  } catch {
    // storage unavailable
  }
}

export const toggleSidebar = () => setSidebarVisible(!sidebarVisible());
export const toggleRightPanel = () => window.dispatchEvent(new Event(RIGHT_PANEL_EVENT));

export const SHORTCUTS: [string, string][] = [
  ["Ctrl+K", "Jump to any chat, issue, doc, canvas, or agent"],
  ["Ctrl+\\", "Show or hide the sidebar"],
  ["Ctrl+Shift+\\", "Show or hide the workspace side panel"],
  ["Alt+Left / Alt+Right", "Back and forward"],
  ["Ctrl+S", "Save the file in the Files tab"],
  ["Enter / Shift+Enter", "Send a chat message / new line"],
  ["@", "Mention a file, doc, or issue in a chat"],
  ["/", "Slash commands in a chat, or insert blocks in a doc"],
  ["V / S / I / C", "Canvas tools: move, select, interact, comment"],
  ["Shift+1", "Fit the canvas to the screen"],
  ["Shift+2", "Zoom to the selected frame"],
];

/** Applies the saved sidebar state and listens for the shortcuts. */
export function initShell(): () => void {
  document.documentElement.dataset.sidebar = sidebarVisible() ? "shown" : "hidden";
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.code !== "Backslash") return;
    e.preventDefault();
    if (e.shiftKey) toggleRightPanel();
    else toggleSidebar();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
