// The color theme is a per-viewer preference, so it lives in this browser only.

export type ThemePref = "dark" | "light" | "system";

// A new key with the sand and night redesign, so everyone starts in sand once.
const KEY = "cadence.appearance";
const media = () => window.matchMedia?.("(prefers-color-scheme: light)");

/** Fired on window whenever the applied theme changes (editors and the terminal restyle on it). */
export const THEME_EVENT = "cadence:theme";

/** Whether the night theme is showing. */
export const isDark = () => document.documentElement.dataset.theme === "dark";

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

function apply(pref: ThemePref): void {
  const light = pref === "light" || (pref === "system" && Boolean(media()?.matches));
  document.documentElement.dataset.theme = light ? "light" : "dark";
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // storage unavailable; the choice lasts for this page only
  }
  apply(pref);
}

/** Applies the saved theme and follows the system setting when asked to. */
export function initTheme(): void {
  apply(themePref());
  if (uiSize() !== 100) document.documentElement.style.fontSize = `${uiSize()}%`;
  // Other tabs and the split pane follow a change made in one of them.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) apply(themePref());
    if (e.key === SIZE_KEY) document.documentElement.style.fontSize = uiSize() === 100 ? "" : `${uiSize()}%`;
  });
  media()?.addEventListener("change", () => themePref() === "system" && apply("system"));
}

// Interface size, also per viewer: a percentage of the browser's base font size.
// Sizes are in rem, so the whole interface scales with it.

const SIZE_KEY = "cadence.uiSize";
export const UI_SIZES = [80, 90, 100, 110, 125, 140] as const;

export function uiSize(): number {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    return (UI_SIZES as readonly number[]).includes(v) ? v : 100;
  } catch {
    return 100;
  }
}

export function setUiSize(size: number): void {
  try {
    localStorage.setItem(SIZE_KEY, String(size));
  } catch {
    // storage unavailable; the choice lasts for this page only
  }
  document.documentElement.style.fontSize = size === 100 ? "" : `${size}%`;
}

/** The next size up or down from the current one, staying in range. */
export function stepUiSize(direction: 1 | -1): number {
  const i = UI_SIZES.indexOf(uiSize() as (typeof UI_SIZES)[number]);
  const next = UI_SIZES[Math.min(UI_SIZES.length - 1, Math.max(0, i + direction))]!;
  setUiSize(next);
  return next;
}
