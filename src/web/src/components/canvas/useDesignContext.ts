import { useEffect, useRef } from "react";
import type { SelectedElement } from "./InspectPanel";

const VIEW = `view-${Math.random().toString(36).slice(2, 10)}`;
const send = (method: "PUT" | "DELETE", body?: unknown) =>
  fetch(`/api/design-context/${VIEW}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: true }).catch(() => undefined);

/**
 * Reports what is selected in this canvas view, so an agent outside the
 * editor can read it with design_context_get. Refreshed every 45 seconds
 * while the view is open; dropped when it closes.
 */
export function useDesignContext(workspaceId: string, path: string, selected: { storyId: string; element: SelectedElement } | null, focusedStory: string | null) {
  const latest = useRef<unknown>(null);
  useEffect(() => {
    const e = selected?.element;
    latest.current = {
      workspaceId,
      path,
      storyId: selected?.storyId ?? focusedStory,
      element: e ? { loc: e.loc, tag: e.tag, className: e.className, text: e.text, rect: e.rect ?? { x: 0, y: 0, width: 0, height: 0 }, ancestors: e.ancestors ?? [], count: e.count } : null,
    };
    void send("PUT", latest.current);
  }, [workspaceId, path, selected?.storyId, selected?.element.loc, focusedStory]);
  useEffect(() => {
    const t = setInterval(() => latest.current && void send("PUT", latest.current), 45_000);
    return () => {
      clearInterval(t);
      void send("DELETE");
    };
  }, [workspaceId, path]);
}
