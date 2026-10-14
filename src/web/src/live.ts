import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatDetail, Snapshot, StoredEvent } from "../../core/types";
import { api } from "./api";

type Listener = (event: StoredEvent) => void;

// One shared EventSource for the whole app. Components subscribe to domain
// events and refetch what they show; streamed assistant text arrives as
// separate "delta" events that are never stored.
const listeners = new Set<Listener>();
const deltaText = new Map<string, string>();
const deltaListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = false;
const connectionListeners = new Set<() => void>();

export interface Viewer {
  memberId: string;
  place: string;
  at: number;
}
let viewers: Viewer[] = [];
const presenceListeners = new Set<() => void>();
const TAB = Math.random().toString(36).slice(2, 10);

export interface CanvasEditing {
  workspaceId: string;
  path: string | null;
  actor: string;
  since: string;
}
let canvasEditing: CanvasEditing[] = [];
const editingListeners = new Set<() => void>();
// After a long disconnect the server says it cannot replay everything missed; live data reloads in full.
const resyncListeners = new Set<() => void>();
function useResync(cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const on = () => ref.current();
    resyncListeners.add(on);
    return () => void resyncListeners.delete(on);
  }, []);
}
const refreshListeners = new Set<(e: { workspaceId: string; path: string | null }) => void>();

/** Agents editing a canvas right now (at the canvas, or the whole workspace). */
export function useCanvasEditing(workspaceId: string, path: string): CanvasEditing | null {
  useEffect(() => {
    ensureSource();
    // The stream only carries changes; ask once for the current state.
    void fetch(`/api/workspaces/${workspaceId}/canvas/editing`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: CanvasEditing[]) => {
        canvasEditing = [...canvasEditing.filter((e) => e.workspaceId !== workspaceId), ...list];
        editingListeners.forEach((l) => l());
      })
      .catch(() => undefined);
  }, [workspaceId]);
  const all = useSyncExternalStore(
    (cb) => {
      editingListeners.add(cb);
      return () => editingListeners.delete(cb);
    },
    () => canvasEditing,
  );
  return all.find((e) => e.workspaceId === workspaceId && (e.path === null || e.path === path)) ?? null;
}

/** Runs `cb` when an agent finishes editing this canvas, so views reload once. */
export function useCanvasRefresh(workspaceId: string, path: string, cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    ensureSource();
    const on = (e: { workspaceId: string; path: string | null }) => e.workspaceId === workspaceId && (e.path === null || e.path === path) && ref.current();
    refreshListeners.add(on);
    return () => {
      refreshListeners.delete(on);
    };
  }, [workspaceId, path]);
}

/**
 * Tells the server what this tab is looking at (every 15 seconds while open)
 * and returns the people looking at the same place.
 */
export function usePresence(place: string | null): Viewer[] {
  useEffect(() => {
    if (!place) return;
    ensureSource();
    const beat = (p: string | null) =>
      fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tab: TAB, place: p }), keepalive: true })
        .then((r) => r.json())
        .then((d: { viewers?: Viewer[] }) => {
          if (d.viewers) {
            viewers = d.viewers;
            presenceListeners.forEach((l) => l());
          }
        })
        .catch(() => undefined);
    void beat(place);
    const t = setInterval(() => void beat(place), 15_000);
    return () => {
      clearInterval(t);
      void beat(null);
    };
  }, [place]);
  const all = useSyncExternalStore(
    (cb) => {
      presenceListeners.add(cb);
      return () => presenceListeners.delete(cb);
    },
    () => viewers,
  );
  return place ? all.filter((v) => v.place === place) : [];
}

function setConnected(value: boolean) {
  connected = value;
  connectionListeners.forEach((l) => l());
}

function ensureSource() {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.addEventListener("domain", (e) => {
    const event = JSON.parse((e as MessageEvent<string>).data) as StoredEvent;
    listeners.forEach((l) => l(event));
  });
  source.addEventListener("resync", () => resyncListeners.forEach((l) => l()));
  source.addEventListener("delta", (e) => {
    const { chatId, text } = JSON.parse((e as MessageEvent<string>).data) as { chatId: string; text: string };
    deltaText.set(chatId, (deltaText.get(chatId) ?? "") + text);
    deltaListeners.forEach((l) => l());
  });
  source.addEventListener("presence", (e) => {
    viewers = (JSON.parse((e as MessageEvent<string>).data) as { viewers: Viewer[] }).viewers;
    presenceListeners.forEach((l) => l());
  });
  source.addEventListener("canvas_editing", (e) => {
    canvasEditing = (JSON.parse((e as MessageEvent<string>).data) as { editing: CanvasEditing[] }).editing;
    editingListeners.forEach((l) => l());
  });
  source.addEventListener("canvas_refresh", (e) => {
    const d = JSON.parse((e as MessageEvent<string>).data) as { workspaceId: string; path: string | null };
    refreshListeners.forEach((l) => l(d));
  });
  source.addEventListener("delta_reset", (e) => {
    const { chatId } = JSON.parse((e as MessageEvent<string>).data) as { chatId: string };
    deltaText.delete(chatId);
    deltaListeners.forEach((l) => l());
  });
}

export function useDomainEvents(listener: Listener) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    ensureSource();
    const wrapped: Listener = (e) => ref.current(e);
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, []);
}

/** Text the assistant is typing right now in this chat (not yet a stored message). */
export function useStreamingText(chatId: string): string {
  return useSyncExternalStore(
    (cb) => {
      ensureSource();
      deltaListeners.add(cb);
      return () => deltaListeners.delete(cb);
    },
    () => deltaText.get(chatId) ?? "",
  );
}

export function useConnected(): boolean {
  return useSyncExternalStore(
    (cb) => {
      connectionListeners.add(cb);
      return () => connectionListeners.delete(cb);
    },
    () => connected,
  );
}

/**
 * Loads data and reloads it whenever a matching event arrives. Each event says
 * how soon it needs to show (`delay`, 120 ms by default); the reload happens by
 * the earliest deadline pending, and later events never push it back, so a
 * steady stream of events costs one reload per delay instead of one per event.
 */
export function useLive<T>(load: () => Promise<T>, deps: unknown[], filter: (e: StoredEvent) => boolean = () => true, delay: (e: StoredEvent) => number = () => 120) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<{ id: number; at: number } | null>(null);
  // Reloads can overlap; only the newest request's answer is used.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const n = ++latest.current;
    load()
      .then((d) => {
        if (n !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => n === latest.current && setError(e.message));
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current.id)), []);

  useResync(reload);
  useDomainEvents((event) => {
    if (!filter(event)) return;
    const at = Date.now() + delay(event);
    if (timer.current && timer.current.at <= at) return;
    if (timer.current) window.clearTimeout(timer.current.id);
    timer.current = {
      at,
      id: window.setTimeout(() => {
        timer.current = null;
        reload();
      }, at - Date.now()),
    };
  });

  return { data, error, reload };
}

const PAGE = 300;

/**
 * One chat, kept live cheaply: the latest page of items first, then only the
 * items added since (transcripts are append-only), with older pages on request.
 */
export function useChat(chatId: string) {
  const [data, setData] = useState<(ChatDetail & { earlier: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<ChatDetail & { earlier: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const set = (d: ChatDetail & { earlier: boolean }) => {
    latest.current = d;
    setData(d);
  };
  useEffect(() => {
    latest.current = null;
    setData(null);
    api.chatPage(chatId, { limit: PAGE }).then(set, (e: Error) => setError(e.message));
  }, [chatId]);
  const refresh = useCallback(() => {
    const cur = latest.current;
    if (!cur) return;
    // One request at a time; an event during it means one more fetch after.
    if (busy.current) return void (again.current = true);
    busy.current = true;
    const last = cur.items.at(-1)?.seq ?? 0;
    api
      .chatPage(chatId, { after: last })
      .then((d) => {
        const base = latest.current ?? cur;
        const known = base.items.at(-1)?.seq ?? 0;
        set({ ...d, earlier: base.earlier, items: [...base.items, ...d.items.filter((i) => i.seq > known)] });
        setError(null);
      }, (e: Error) => setError(e.message))
      .finally(() => {
        busy.current = false;
        if (again.current) {
          again.current = false;
          refresh();
        }
      });
  }, [chatId]);
  useResync(refresh);
  useDomainEvents((event) => {
    if (event.aggregate !== "chat" || event.aggregateId !== chatId) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(refresh, 120);
  });
  const loadEarlier = useCallback(async () => {
    const cur = latest.current;
    if (!cur?.earlier) return;
    const page = await api.chatPage(chatId, { limit: PAGE, before: cur.items[0]?.seq });
    const now = latest.current ?? cur;
    set({ ...now, earlier: page.earlier, items: [...page.items, ...now.items] });
  }, [chatId]);
  return { data, error, loadEarlier };
}

export function useSnapshot() {
  // Chat transcript items are high volume and loaded per chat, not in the snapshot.
  // A streaming chat only changes the snapshot's unread dots and timestamps, so it refreshes at most once a second;
  // the open chat itself updates through useChat. Its status changes and everything else show within 120 ms.
  return useLive<Snapshot>(
    api.snapshot,
    [],
    (e) => e.type !== "ChatItemAdded" || (e.payload.item as { kind: string }).kind !== "tool_result",
    (e) => (e.type === "ChatItemAdded" || e.type === "ChatUsage" || e.type === "ChatSessionStarted" ? 1000 : 120),
  );
}
