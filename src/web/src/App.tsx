import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { interceptWorkspaceLinks } from "./links";
import { ChatsView } from "./components/chat/ChatsView";
import { InteractionCard } from "./components/chat/InteractionCard";
import { useConnected, useSnapshot } from "./live";
import { api } from "./api";
import { OrgSwitcher } from "./components/OrgSwitcher";
import { HomeView } from "./components/home/HomeView";
import { UserAvatar } from "./components/ui";
import { HelpMenu, IN_PANE, NavArrows, SplitPane, OPEN_BESIDE_EVENT } from "./components/Workbench";
import { initShell } from "./shell";
import { InboxButton } from "./components/InboxButton";
import { QuickOpen } from "./components/QuickOpen";
import { InterruptedBanner } from "./components/InterruptedBanner";
import { setUiSize, stepUiSize } from "./theme";
import { needsOnboarding } from "./components/home/needs-onboarding";
import { desktop, useDesktopEvents, type DesktopEvent } from "./desktop";
import { LogoLoader } from "./components/Logo";

// The doc editor (TipTap, mermaid) is heavy, so it loads on first use.
const DocsView = lazy(() => import("./components/DocsView").then((m) => ({ default: m.DocsView })));
const CanvasView = lazy(() =>
  import("./components/canvas/CanvasView").then((m) => ({
    default: m.CanvasView,
  })),
);
// Pages most visits never open load when first visited, so chats start faster.
const IssuesView = lazy(() => import("./components/issues/IssuesView").then((m) => ({ default: m.IssuesView })));
const AgentsView = lazy(() => import("./components/agents/AgentsView").then((m) => ({ default: m.AgentsView })));
const SettingsView = lazy(() => import("./components/settings/SettingsView").then((m) => ({ default: m.SettingsView })));
const pageLoading = <LogoLoader />;
// Screens a session rarely shows: sign-in, invites, shared links, connector consent, first-run setup, bug reports.
const SignIn = lazy(() => import("./components/auth/SignIn").then((m) => ({ default: m.SignIn })));
const AcceptInvite = lazy(() => import("./components/auth/SignIn").then((m) => ({ default: m.AcceptInvite })));
const SharedView = lazy(() => import("./components/share/SharedView").then((m) => ({ default: m.SharedView })));
const OAuthConsent = lazy(() => import("./components/auth/OAuthConsent").then((m) => ({ default: m.OAuthConsent })));
const Onboarding = lazy(() => import("./components/home/Onboarding").then((m) => ({ default: m.Onboarding })));
const BugReport = lazy(() => import("./components/BugReport").then((m) => ({ default: m.BugReport })));

export type View = "home" | "chats" | "issues" | "agents" | "docs" | "canvas" | "settings";

export interface Route {
  view: View;
  id: string | null;
}

function parseHash(): Route {
  // "?..." after the route carries extras (a comment to open, a repo to clone), not the id.
  const [view, id] = (window.location.hash.replace(/^#\/?/, "").split("?")[0] ?? "").split("/");
  const known: View[] = ["home", "chats", "issues", "agents", "docs", "canvas", "settings"];
  return {
    view: known.includes(view as View) ? (view as View) : "home",
    id: id ? decodeURIComponent(id) : null,
  };
}

export function navigate(view: View, id: string | null = null) {
  window.location.hash = `/${view}${id ? `/${encodeURIComponent(id)}` : ""}`;
}

const ICONS: Record<View, ReactNode> = {
  home: <path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />,
  chats: <path d="M5 5h14v10H9l-4 4zM9 9h6M9 12h4" />,
  issues: <path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z" />,
  agents: <path d="M8 8h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM12 4v4M9.5 13h.01M14.5 13h.01" />,
  docs: <path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />,
  canvas: <path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" />,
  settings: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12l2-1-1-3-2 .2-1.3-1.3.2-2-3-1-1 2h-1.8l-1-2-3 1 .2 2L6 7.2 4 7 3 10l2 1v2l-2 1 1 3 2-.2 1.3 1.3-.2 2 3 1 1-2h1.8l1 2 3-1-.2-2 1.3-1.3 2 .2 1-3-2-1z" />,
};

const LABELS: Record<View, string> = {
  home: "Home",
  chats: "Chats",
  issues: "Issues",
  agents: "Agents",
  docs: "Docs",
  canvas: "Canvases",
  settings: "Settings",
};

/** Signed out: sign in, or join through an invite link. Signed in: the app. */
export function App() {
  const [state, setState] = useState<"checking" | "in" | "out">("checking");
  const [hash, setHash] = useState(window.location.hash);
  const check = () =>
    api.me().then(
      (m) => setState(m.signedIn ? "in" : "out"),
      () => setState("out"),
    );
  useEffect(() => {
    void check();
    const out = () => setState("out");
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("cadence:signed-out", out);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("cadence:signed-out", out);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  // Share links are public: no sign-in.
  if (hash.startsWith("#/share/"))
    return (
      <Suspense fallback={pageLoading}>
        <SharedView id={decodeURIComponent(hash.slice(8).split("/")[0] ?? "")} />
      </Suspense>
    );
  const invite = hash.startsWith("#/invite/") ? hash.slice(9).split("/")[0] : undefined;
  if (invite && state !== "in")
    return (
      <Suspense fallback={pageLoading}>
        <AcceptInvite token={invite} onDone={() => void check()} />
      </Suspense>
    );
  if (state === "checking") return <LogoLoader fullScreen />;
  if (state === "out")
    return (
      <Suspense fallback={pageLoading}>
        <SignIn onDone={() => void check()} />
      </Suspense>
    );
  // A chat app connecting over OAuth: ask the signed-in person.
  if (hash.startsWith("#/oauth?"))
    return (
      <Suspense fallback={pageLoading}>
        <OAuthConsent query={hash.slice(8)} />
      </Suspense>
    );
  return <SignedInApp />;
}

function SignedInApp() {
  const [route, setRoute] = useState(parseHash);
  const { data, error } = useSnapshot();
  const connected = useConnected();
  // Decided once, on first load: making a project during onboarding must not end it.
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  const [split, setSplit] = useState(() => {
    try {
      return !IN_PANE && sessionStorage.getItem("cadence.split") === "1";
    } catch {
      return false;
    }
  });
  const [reporting, setReporting] = useState(false);
  // The desktop app's menu: Settings opens settings, Report a Problem the bug report.
  useDesktopEvents(
    useCallback((e: DesktopEvent) => {
      if (e.type === "menu" && e.action === "settings") navigate("settings");
      if (e.type === "menu" && e.action === "report") setReporting(true);
      if (e.type === "update") setUpdateReady(e.state.status === "ready" ? e.state.next : null);
    }, []),
  );
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  useEffect(() => {
    void desktop?.updateState().then((s) => setUpdateReady(s.status === "ready" ? s.next : null));
  }, []);
  const [quickOpen, setQuickOpen] = useState(false);
  // Disconnected for more than a few seconds (a blip is not worth a banner).
  const [outage, setOutage] = useState(false);
  useEffect(() => {
    if (connected) return setOutage(false);
    const t = window.setTimeout(() => setOutage(true), 5000);
    return () => window.clearTimeout(t);
  }, [connected]);
  useEffect(() => {
    // Ctrl+K / Cmd+K, except inside the doc editor, where it makes a link.
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Alt+= / - / 0: interface size (plain Ctrl+= stays the browser's page zoom).
      if ((e.ctrlKey || e.metaKey) && e.altKey && ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"].includes(e.code)) {
        e.preventDefault();
        if (e.code.endsWith("0")) setUiSize(100);
        else stepUiSize(e.code === "Equal" || e.code === "NumpadAdd" ? 1 : -1);
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k" || (e.target as Element | null)?.closest?.(".ProseMirror, .cm-editor")) return;
      e.preventDefault();
      setQuickOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const on = () => setSplit(true);
    window.addEventListener(OPEN_BESIDE_EVENT, on);
    return () => window.removeEventListener(OPEN_BESIDE_EVENT, on);
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem("cadence.split", split ? "1" : "0");
    } catch {
      // storage unavailable
    }
  }, [split]);
  useEffect(() => {
    if (data && onboarding === null) setOnboarding(IN_PANE ? false : needsOnboarding(data));
  }, [data, onboarding]);

  useEffect(() => interceptWorkspaceLinks(), []);
  useEffect(() => initShell(), []);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const working = data?.runs.filter((r) => r.status === "running").length ?? 0;
  const pending = data?.pendingInteractions ?? [];
  const unread = data?.chats.filter((c) => c.unread && !c.archived).length ?? 0;
  const labelFor = (chatId: string) => {
    const chat = data?.chats.find((c) => c.id === chatId);
    const agent = data?.agents.find((a) => a.id === chat?.agentId);
    return `${agent ? agent.name : "Chat"}: ${chat?.title ?? ""}`;
  };

  return (
    <div className="flex h-dvh">
      {!IN_PANE && (
        <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-zinc-900 bg-zinc-950 py-3">
          <OrgSwitcher />
          <NavArrows />
          {(["home", "chats", "issues", "agents", "docs", "canvas"] as View[]).map((v) => (
            <a key={v} href={`#/${v}`} title={LABELS[v]} className={`relative grid size-10 place-items-center rounded-lg ${route.view === v ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"}`}>
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                {ICONS[v]}
              </svg>
              {v === "agents" && working > 0 && <span className="absolute top-1.5 right-1.5 size-2 animate-pulse rounded-full bg-violet-400" />}
              {v === "chats" && unread > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-sky-400" />}
            </a>
          ))}
          <div className="mt-auto flex flex-col items-center gap-2">
            <button
              title={split ? "Close split view" : "Split view: a second view beside this one"}
              onClick={() => setSplit(!split)}
              className={`grid size-8 place-items-center rounded-lg ${split ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"}`}
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                <path d="M4 5h16v14H4zM12 5v14" />
              </svg>
            </button>
            {data && <InboxButton snapshot={data} />}
            <HelpMenu onReportBug={() => setReporting(true)} />
          <button title="Report a problem" onClick={() => setReporting(true)} className="grid size-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 7a3 3 0 0 1 6 0M7 10h10v5a5 5 0 0 1-10 0zM12 10v10M4 13h3M17 13h3M5 8l2 2M19 8l-2 2M5 19l2-2M19 19l-2-2" />
              </svg>
            </button>
            <span title={connected ? "Live" : "Reconnecting"} className={`size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-600"}`} />
            {data && data.members.length > 1 && (
              <button
                title={`Signed in as ${data.members.find((m) => m.id === data.viewer.memberId)?.name ?? "you"}. Click to sign out.`}
                onClick={() => confirm("Sign out of Cadence?") && void api.logout().then(() => window.dispatchEvent(new Event("cadence:signed-out")))}
              >
                <UserAvatar size="size-7" member={data.members.find((m) => m.id === data.viewer.memberId)} />
              </button>
            )}
            <a href="#/settings" title="Settings" className={`grid size-10 place-items-center rounded-lg ${route.view === "settings" ? "bg-zinc-800" : "text-zinc-500 hover:bg-zinc-900"}`}>
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                {ICONS.settings}
              </svg>
            </a>
          </div>
        </nav>
      )}

      <main className="relative min-w-0 flex-1 overflow-hidden">
        {error && <p className="p-6 text-sm text-red-400">Could not reach the Cadence server: {error}</p>}
        {!data && !error && <LogoLoader />}
        {data && route.view === "chats" && <ChatsView snapshot={data} selected={route.id} />}
        {data && route.view === "issues" && (
          <Suspense fallback={pageLoading}>
            <IssuesView snapshot={data} selected={route.id} />
          </Suspense>
        )}
        {data && route.view === "agents" && (
          <Suspense fallback={pageLoading}>
            <AgentsView snapshot={data} selected={route.id} />
          </Suspense>
        )}
        {data && route.view === "docs" && (
          <Suspense fallback={<LogoLoader label="Opening docs" />}>
            <DocsView snapshot={data} selected={route.id} />
          </Suspense>
        )}
        {data && route.view === "canvas" && (
          <Suspense fallback={<LogoLoader label="Opening canvases" />}>
            <CanvasView snapshot={data} selected={route.id} />
          </Suspense>
        )}
        {data && route.view === "settings" && (
          <Suspense fallback={pageLoading}>
            <SettingsView snapshot={data} initial={route.id} />
          </Suspense>
        )}
        {data && route.view === "home" && <HomeView snapshot={data} />}
        {data && onboarding && (
          <Suspense fallback={null}>
            <Onboarding snapshot={data} onClose={() => setOnboarding(false)} />
          </Suspense>
        )}

        {data && !IN_PANE && <InterruptedBanner snapshot={data} />}
        {outage && <div className="absolute top-3 right-4 z-40 rounded-lg bg-red-950 px-3 py-1.5 text-sm text-red-200 shadow-xl ring-1 ring-red-900">Lost the connection to Cadence. Reconnecting; changes made now may not show until it is back.</div>}
        {updateReady && (
          <div className="absolute top-3 right-4 z-40 flex items-center gap-3 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 shadow-xl ring-1 ring-zinc-700">
            Cadence {updateReady} is ready.
            <button className="text-violet-300 hover:underline" onClick={() => void desktop?.installUpdate()}>
              Restart to update
            </button>
            <button className="text-zinc-500 hover:text-zinc-200" aria-label="Later" onClick={() => setUpdateReady(null)}>
              ×
            </button>
          </div>
        )}
        {data && quickOpen && <QuickOpen snapshot={data} onClose={() => setQuickOpen(false)} />}
        {data && reporting && (
          <Suspense fallback={null}>
            <BugReport snapshot={data} onClose={() => setReporting(false)} />
          </Suspense>
        )}
        {pending.length > 0 && !IN_PANE && route.view !== "chats" && (
          <div className="absolute right-4 bottom-4 z-30 max-h-[70vh] w-[28rem] space-y-2 overflow-y-auto">
            {pending.slice(0, 3).map((p) => (
              <div key={p.id} className="space-y-1 rounded-xl bg-zinc-950 shadow-2xl">
                <InteractionCard it={p} label={labelFor(p.chatId)} />
                <a href={`#/chats/${p.chatId}`} className="block px-3 pb-2 text-xs text-violet-300 hover:underline">
                  Open chat
                </a>
              </div>
            ))}
            {pending.length > 3 && <p className="text-right text-xs text-zinc-400">+{pending.length - 3} more waiting</p>}
          </div>
        )}
      </main>
      {split && <SplitPane onClose={() => setSplit(false)} />}
    </div>
  );
}
