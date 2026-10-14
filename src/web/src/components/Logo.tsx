// Cadence's mark: a lowercase c drawn as one open arc, with a dot in its
// opening for the beat. The same geometry is in src/desktop/icon.svg (the app
// icon) and the desktop app's startup screen (src/desktop/main.ts).

/** The arc, open to the right: from the top of the opening, counterclockwise round to the bottom. */
export const MARK_ARC = "M40.02 19.98 A17 17 0 1 0 40.02 44.02";
export const MARK_DOT = { cx: 47, cy: 32, r: 4.5 };

/** The mark. `animated` draws the arc in a loop with the dot keeping time (styles.css, .cadence-mark). */
export function CadenceMark({ size = 32, animated = false, className = "" }: { size?: number; animated?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={`${animated ? "cadence-mark-animated" : ""} ${className}`} role="img" aria-label="Cadence">
      <path className="cadence-mark-arc" d={MARK_ARC} pathLength={100} fill="none" stroke="var(--color-zinc-100)" strokeWidth={7} strokeLinecap="round" />
      <circle className="cadence-mark-dot" {...MARK_DOT} fill="var(--color-violet-400)" />
    </svg>
  );
}

/** A loading state: the animated mark, with an optional line under it. Fills its container, or the whole screen. */
export function LogoLoader({ label, fullScreen = false }: { label?: string; fullScreen?: boolean }) {
  return (
    <div className={`grid place-items-center ${fullScreen ? "h-dvh bg-zinc-950" : "h-full min-h-40 p-8"}`} role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3">
        <CadenceMark size={fullScreen ? 72 : 44} animated />
        {label && <p className="font-display text-lg text-zinc-400 italic">{label}</p>}
        {!label && <span className="sr-only">Loading</span>}
      </div>
    </div>
  );
}
