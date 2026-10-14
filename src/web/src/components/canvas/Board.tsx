import { useEffect, useRef, useState, type ReactNode } from "react";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * An infinite board: drag empty space (or hold Space) to pan, scroll to pan,
 * Ctrl/Cmd + scroll to zoom around the pointer. Children are placed in board
 * coordinates.
 */
/**
 * Whether the canvas's own board color is light or dark, so labels and menus on it use
 * the matching neutrals (styles.css) whatever the app theme.
 */
export function boardTone(color: string): "light" | "dark" | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color.trim());
  const parts = hex ? (hex.length === 3 ? [...hex].map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16))) : rgb ? rgb.slice(1, 4).map(Number) : null;
  if (!parts) return undefined;
  const [r, g, b] = parts.map((v) => {
    const c = v! / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.3 ? "dark" : "light";
}

export function Board({
  view,
  onView,
  background,
  onBackgroundClick,
  cursor,
  children,
}: {
  view: Viewport;
  onView: (v: Viewport) => void;
  background: string;
  onBackgroundClick?: (boardX: number, boardY: number) => void;
  cursor?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [space, setSpace] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        setSpace(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const zoom = clampZoom(v.zoom * Math.exp(-e.deltaY * 0.0015));
        // Keep the point under the pointer fixed.
        onView({ zoom, x: px - ((px - v.x) / v.zoom) * zoom, y: py - ((py - v.y) / v.zoom) * zoom });
      } else {
        onView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onView]);

  const toBoard = (clientX: number, clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
  };

  return (
    <div
      ref={ref}
      data-board-tone={boardTone(background)}
      className="relative h-full w-full overflow-hidden text-zinc-100 select-none"
      style={{ background, cursor: space ? (drag.current ? "grabbing" : "grab") : cursor, backgroundImage: "radial-gradient(rgba(120,92,72,0.28) 1px, transparent 1px)", backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={(e) => {
        const onBackground = e.target === e.currentTarget || (e.target as HTMLElement).dataset.board === "layer";
        if (!onBackground && !space) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
        onView({ ...view, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved && onBackgroundClick) {
          const p = toBoard(e.clientX, e.clientY);
          onBackgroundClick(p.x, p.y);
        }
      }}
    >
      <div data-board="layer" className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, pointerEvents: space ? "none" : undefined }}>
        {children}
      </div>
    </div>
  );
}
