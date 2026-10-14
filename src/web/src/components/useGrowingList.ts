import { useEffect, useRef, useState } from "react";

/**
 * Renders a long list in batches: the first `batch` items, then another batch
 * whenever the returned sentinel scrolls near view, so a column of thousands
 * of cards costs only what is on screen. Scrolling still reaches every item.
 */
export function useGrowingList<T>(items: T[], batch = 60): { visible: T[]; more: number; sentinel: (el: HTMLElement | null) => void } {
  const [limit, setLimit] = useState(batch);
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  const sentinel = (el: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    observer.current = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setLimit((l) => l + batch), { rootMargin: "600px" });
    observer.current.observe(el);
  };
  return { visible: items.length > limit ? items.slice(0, limit) : items, more: Math.max(0, items.length - limit), sentinel };
}
