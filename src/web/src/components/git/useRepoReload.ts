import { useEffect, useRef } from "react";
import { useDomainEvents } from "../../live";

/**
 * Reloads git state when this workspace's chats run a tool (an agent editing
 * files or running git). Bursts collapse into one reload, and reloads never
 * overlap: each runs several git processes, which are slow on some machines.
 */
export function useRepoReload(load: () => Promise<unknown>, chatIds: ReadonlySet<string>): void {
  const timer = useRef<number | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const latest = useRef(load);
  latest.current = load;
  const ids = useRef(chatIds);
  ids.current = chatIds;
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  const run = () => {
    if (busy.current) return void (again.current = true);
    busy.current = true;
    void latest.current().finally(() => {
      busy.current = false;
      if (again.current) {
        again.current = false;
        run();
      }
    });
  };
  useDomainEvents((e) => {
    if (e.type !== "ChatItemAdded" || (e.payload.item as { kind: string }).kind !== "tool_result" || !ids.current.has(e.aggregateId)) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, 400);
  });
}
