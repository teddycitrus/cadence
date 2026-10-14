import { useCallback, useEffect, useRef, useState } from "react";
import { PropsPopover } from "./PropsPopover";
import { ArrangeBar } from "./ArrangeBar";
import type { CanvasComment, CanvasEdit, Snapshot } from "../../../../core/types";
import { api, type AppFrame, type BuildStatus, type DesignToken, type CanvasInfo, type DevServer, type StoryboardInfo, type VrtResult } from "../../api";
import { navigate } from "../../App";
import { Button, ErrorText, useAction } from "../ui";
import { Board, clampZoom, type Viewport } from "./Board";
import { CommentsLayer, type DraftPin } from "./CommentsLayer";
import { CANVAS_TOOLS as TOOLS, FrameView, PICKS_ELEMENTS, type Tool } from "./FrameView";
import { InspectPanel, type SelectedElement, type TreeNode } from "./InspectPanel";
import { VrtPanel } from "./VrtPanel";
import { VariablesPanel } from "./VariablesPanel";
import { ComponentsPanel } from "./ComponentsPanel";
import { ActivityPanel } from "./ActivityPanel";
import { CanvasChatPanel } from "./CanvasChatPanel";
import { Viewers } from "../Viewers";
import { ShareButton } from "../share/ShareButton";
import { useCanvasRefresh } from "../../live";
import { AgentEditingBanner } from "./AgentEditingBanner";
import { DrawingOption, drawingChoice, isDrawingTool } from "./DrawingOptions";
import type { DrawingTool } from "../../../../canvas/new-elements";
import { useDesignContext } from "./useDesignContext";
import { useFigmaPaste, useOpenChatOnContext } from "./useCanvasEvents";
import { IN_PANE } from "../Workbench";
import { NO_APP, storySrc } from "./story-src";
import { linkOrigin } from "../../public-url";

/** The canvas editor: frames on a board, element selection, style panel, comments, and visual checks. */
export function CanvasEditor({ snapshot, workspaceId, path }: { snapshot: Snapshot; workspaceId: string; path: string }) {
  const [canvas, setCanvas] = useState<(CanvasInfo & { source?: string }) | null>(null);
  const [dev, setDev] = useState<DevServer | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [view, setView] = useState<Viewport>({ x: 80, y: 80, zoom: 0.5 });
  // When an agent finishes editing this canvas, the frames reload once.
  const [reloads, setReloads] = useState(0);
  useCanvasRefresh(workspaceId, path, () => setReloads((n) => n + 1));
  const [selected, setSelected] = useState<{ storyId: string; element: SelectedElement } | null>(null);
  useDesignContext(workspaceId, path, selected, null);
  // Frames picked with Shift+click, to align or distribute together.
  const [picked, setPicked] = useState<string[]>([]);
  const [propsFor, setPropsFor] = useState<string | null>(null);
  useEffect(() => setPicked([]), [workspaceId, path]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [trees, setTrees] = useState<Record<string, TreeNode[]>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [ledger, setLedger] = useState<CanvasEdit[]>([]);
  const [comments, setComments] = useState<CanvasComment[]>([]);
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [vrt, setVrt] = useState<VrtResult[] | null>(null);
  const [vrtOpen, setVrtOpen] = useState(false);
  const [app, setApp] = useState<AppFrame | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [build, setBuild] = useState<BuildStatus | null>(null);
  const [tokens, setTokens] = useState<DesignToken[]>([]);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [componentsOpen, setComponentsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [detach, setDetach] = useState<{ storyId: string; storyName: string; components: { name: string; source: string }[] } | null>(null);
  useEffect(() => {
    api.designTokens(workspaceId).then(setTokens, () => undefined);
  }, [workspaceId]);
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});
  const wrap = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const action = useAction();
  const checking = useAction();
  const ws = snapshot.workspaces.find((w) => w.id === workspaceId);

  const load = useCallback(() => api.canvasFile(workspaceId, path).then((c) => setCanvas((prev) => (prev?.source === c.source ? prev : c))), [workspaceId, path]);
  useEffect(() => {
    load().catch((e: Error) => action.setError(e.message));
    api.canvasDev(workspaceId).then(setDev, (e: Error) => action.setError(`Canvas server: ${e.message}`));
    api.canvasLedger(workspaceId).then(setLedger, () => undefined);
    api.canvasComments(workspaceId).then(setComments, () => undefined);
    // Agents and editors change canvas files on disk; pick that up.
    // (Not while the window is hidden; it checks again as soon as it is shown.)
    const tick = () => document.visibilityState === "visible" && void load().catch(() => undefined);
    const t = setInterval(tick, 2500);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [workspaceId, path]);

  /** Fits every frame on screen, or just one (zoom to selection). */
  const fit = useCallback((only?: string) => {
    if (!canvas?.storyboards.length || !wrap.current) return;
    const fs = canvas.storyboards.filter((s) => !only || s.id === only).map((s) => s.frame);
    if (!fs.length) return;
    const minX = Math.min(...fs.map((f) => f.x));
    const minY = Math.min(...fs.map((f) => f.y)) - 40;
    const maxX = Math.max(...fs.map((f) => f.x + f.width));
    const maxY = Math.max(...fs.map((f) => f.y + f.height));
    const { clientWidth: w, clientHeight: h } = wrap.current;
    const zoom = clampZoom(Math.min((w - 120) / (maxX - minX), (h - 120) / (maxY - minY), only ? 2 : 1));
    setView({ zoom, x: (w - (maxX - minX) * zoom) / 2 - minX * zoom, y: (h - (maxY - minY) * zoom) / 2 - minY * zoom });
  }, [canvas]);
  useEffect(() => {
    if (canvas && !fitted.current) {
      fitted.current = true;
      fit();
    }
  }, [canvas, fit]);

  // Route frames on the app's own dev server: start it (when the canvas says how) and its bridge proxy.
  const usesApp = Boolean(canvas && (canvas.appUrl || canvas.appCommand) && canvas.storyboards.some((s) => s.kind === "route"));
  useEffect(() => {
    if (!usesApp) return;
    setAppError(null);
    api.canvasApp(workspaceId, path).then(setApp, (e: Error) => setAppError(e.message));
    api.canvasBuild(workspaceId).then(setBuild, () => undefined);
  }, [usesApp, canvas?.appUrl, canvas?.appCommand, workspaceId, path]);
  const origins = [dev && new URL(dev.url).origin, app && new URL(app.proxyUrl).origin].filter(Boolean) as string[];

  const post = (storyId: string, msg: Record<string, unknown>) => {
    const f = frames.current[storyId];
    const w = f?.contentWindow;
    // Each frame only hears from its own origin: the canvas devserver or the app proxy.
    if (w && f?.src) w.postMessage({ source: "cadence-host", ...msg }, new URL(f.src).origin);
  };

  // Tell every frame whether clicks select elements.
  useEffect(() => {
    for (const id of Object.keys(frames.current)) post(id, { type: "mode", select: PICKS_ELEMENTS(tool) });
  }, [tool, dev, canvas?.storyboards.length]);

  useEffect(() => {
    if (!dev) return;
    const onMessage = (e: MessageEvent) => {
      if (!origins.includes(e.origin) || e.data?.source !== "cadence-canvas") return;
      const storyId = Object.entries(frames.current).find(([, f]) => f?.contentWindow === e.source)?.[0];
      if (!storyId) return;
      const m = e.data as { type: string; element?: SelectedElement; nodes?: TreeNode[]; message?: string };
      if (m.type === "ready") {
        setErrors((x) => ({ ...x, [storyId]: null }));
        post(storyId, { type: "mode", select: PICKS_ELEMENTS(tool) });
      } else if (m.type === "selected" && m.element && (tool === "div" || tool === "rectangle" || tool === "text")) {
        // A drawing tool adds a new element inside the one clicked, then hands back to Select.
        const loc = m.element.loc;
        setTool("select");
        void action.run(() => api.insertElement(workspaceId, loc, drawingChoice(tool)));
      } else if (m.type === "selected" && m.element) setSelected({ storyId, element: m.element });
      else if (m.type === "tree" && m.nodes) setTrees((t) => ({ ...t, [storyId]: m.nodes! }));
      else if (m.type === "error") setErrors((x) => ({ ...x, [storyId]: m.message ?? "Error" }));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [dev, tool, app]);


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) setTool(t.id);
      if (e.key === "Escape") {
        setSelected(null);
        setPicked([]);
        setDraft(null);
        for (const id of Object.keys(frames.current)) post(id, { type: "clear" });
      }
      if (e.key === "!" || (e.key === "1" && e.shiftKey)) fit();
      if ((e.key === "@" || (e.key === "2" && e.shiftKey)) && selectedRef.current) fit(selectedRef.current.storyId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fit, dev]);

  const update = (fn: () => Promise<CanvasInfo>) => action.run(async () => setCanvas(await fn()));
  useFigmaPaste(workspaceId, path, (url) => void update(() => api.importFigma(workspaceId, path, url)));
  useOpenChatOnContext(workspaceId, () => setChatOpen(true));
  const runChecks = (storyId?: string) =>
    checking.run(async () => {
      setVrtOpen(true);
      const r = await api.checkVisuals(workspaceId, path, storyId);
      setVrt((prev) => (storyId ? [...(prev ?? []).filter((x) => x.storyId !== storyId), ...r] : r));
    });

  const editContext = () => {
    const s = canvas?.storyboards.find((x) => x.id === selected?.storyId);
    return s && selected ? { canvasPath: path, storyId: s.id, storyName: s.name, copies: selected.element.count } : undefined;
  };

  if (!canvas) return <div className="p-8 text-sm text-zinc-500">{action.error ?? "Loading canvas..."}</div>;
  const story = selected ? canvas.storyboards.find((s) => s.id === selected.storyId) : null;
  const pathComments = comments.filter((c) => c.canvasPath === path);

  return (
    <div className="flex h-full flex-col">
      {/* Sized by its pane (container queries), so the split view stays on one line. */}
      <div className="@container flex items-center gap-3 border-b border-zinc-900 px-4 py-2 text-sm">
        <a href="#/canvas" className="hidden shrink-0 text-zinc-500 hover:text-zinc-100 @3xl:inline">
          Canvases
        </a>
        <span className="hidden text-zinc-700 @3xl:inline">/</span>
        <span className="max-w-56 min-w-20 shrink truncate font-medium whitespace-nowrap" title={canvas.name}>
          {canvas.name}
        </span>
        <span className="hidden min-w-0 truncate font-mono text-xs text-zinc-500 @5xl:inline" title={`${ws?.branch ?? ""} · ${canvas.path}`}>
          {ws?.branch} · {canvas.path}
        </span>
        <div className="flex shrink-0 rounded-md bg-zinc-900 p-0.5 ring-1 ring-zinc-800 @3xl:ml-4">
          {TOOLS.map((t) => (
            <button key={t.id} title={`${t.label} (${t.key.toUpperCase()})`} onClick={() => setTool(t.id)} className={`rounded px-2 py-0.5 text-xs ${tool === t.id ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>
              {t.label}
            </button>
          )).flatMap((b, i) => (isDrawingTool(TOOLS[i]!.id) ? [b, <DrawingOption key={`${TOOLS[i]!.id}-opt`} tool={TOOLS[i]!.id as DrawingTool} onPick={() => setTool(TOOLS[i]!.id)} />] : [b]))}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2 overflow-x-auto text-xs whitespace-nowrap text-zinc-400 [scrollbar-width:none]">
          <Viewers place={`canvas:${workspaceId}|${path}`} snapshot={snapshot} />
          <ShareButton kind="canvas" refId={`${workspaceId}|${path}`} />
          <button onClick={() => setView((v) => ({ ...v, zoom: clampZoom(v.zoom / 1.25) }))}>−</button>
          <span className="w-10 text-center">{Math.round(view.zoom * 100)}%</span>
          <button onClick={() => setView((v) => ({ ...v, zoom: clampZoom(v.zoom * 1.25) }))}>+</button>
          <button className="hover:text-zinc-100" onClick={() => fit()} title="Fit (Shift+1)">
            Fit
          </button>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Resolved
          </label>
          <Button
            className="py-1! text-xs"
            title="Or paste a Figma frame link anywhere on the canvas"
            onClick={() => {
              const url = prompt("Figma frame link (right-click a frame > Copy link)");
              if (url) void update(() => api.importFigma(workspaceId, path, url));
            }}
          >
            Import Figma
          </Button>
          <select
            className="rounded-md bg-zinc-900 px-2 py-1 text-xs text-zinc-300 ring-1 ring-zinc-800"
            value=""
            title="Agent jobs about the design system"
            onChange={(e) => {
              const tool = e.target.value as "generate" | "audit" | "review" | "harden";
              if (tool) void action.run(async () => navigate("chats", (await api.runDesignTool(workspaceId, tool)).chatId));
            }}
          >
            <option value="">Design actions...</option>
            <option value="generate">Generate design system</option>
            <option value="audit">Audit violations</option>
            <option value="review">Design review of this branch</option>
            <option value="harden">Harden components (proposes first)</option>
          </select>
          <Button className="py-1! text-xs" onClick={() => void update(() => api.tidyCanvas(workspaceId, path))} title="Arrange the frames in even rows (locked ones stay put)">
            Tidy up
          </Button>
          <Button className="py-1! text-xs" onClick={() => setChatOpen(!chatOpen)} title="A workspace chat beside the canvas">
            Chat
          </Button>
          {!IN_PANE && <Button className="py-1! text-xs" title="Open this canvas in its own window" onClick={() => window.open(`${window.location.pathname}?pane=1${window.location.hash}`, "_blank", "popup,width=1280,height=820")}>Pop out</Button>}
          <Button className="py-1! text-xs" onClick={() => setActivityOpen(!activityOpen)} title="Comment threads, commits, and staged edits on this canvas">
            Comments
          </Button>
          <Button className="py-1! text-xs" onClick={() => setComponentsOpen(!componentsOpen)} title="Insert the project's assets and components">
            Assets
          </Button>
          <Button className="py-1! text-xs" onClick={() => setVariablesOpen(!variablesOpen)} title="Design tokens: the project's CSS variables">
            Variables
          </Button>
          <Button className="py-1! text-xs" disabled={checking.busy} onClick={() => void runChecks()}>
            {checking.busy ? "Rendering..." : "Check visuals"}
          </Button>
          <Button className="py-1! text-xs" onClick={() => navigate("chats", workspaceId)}>
            Open workspace
          </Button>
        </div>
      </div>
      <ErrorText>{action.error ?? checking.error}</ErrorText>
      {detach && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => setDetach(null)}>
          <div className="w-96 space-y-3 rounded-xl bg-zinc-900 p-4 shadow-2xl ring-1 ring-zinc-700" onClick={(e) => e.stopPropagation()}>
            <p className="font-display text-lg">Fork a component in "{detach.storyName}"</p>
            <p className="text-xs text-zinc-400">The frame gets its own copy of the component, next to the original. Edits to the copy change this frame only.</p>
            {detach.components.length ? (
              detach.components.map((cpt) => (
                <button
                  key={cpt.name}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ring-1 ring-zinc-800 hover:bg-zinc-800"
                  onClick={() =>
                    void update(async () => {
                      const r = await api.detachComponent(workspaceId, path, detach.storyId, cpt.name);
                      setDetach(null);
                      return r;
                    })
                  }
                >
                  <span className="font-mono">&lt;{cpt.name} /&gt;</span>
                  <span className="truncate font-mono text-xs text-zinc-500">{cpt.source}</span>
                </button>
              ))
            ) : (
              <p className="text-sm text-zinc-500">This frame renders no components imported from the project.</p>
            )}
            <Button variant="ghost" onClick={() => setDetach(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {canvas.errors.length > 0 && <p className="bg-amber-950/50 px-4 py-1 text-xs text-amber-200">This canvas has syntax errors: {canvas.errors[0]}</p>}
      {appError && <p className="bg-red-950/50 px-4 py-1 text-xs whitespace-pre-wrap text-red-200">App dev server: {appError}</p>}
      {usesApp && build && (build.framework === "next" || build.framework === "expo") && !build.configured && (
        <p className="flex items-center gap-3 bg-zinc-900 px-4 py-1.5 text-xs text-zinc-300">
          Route frames load your {build.framework === "next" ? "Next.js" : "Expo"} app, which needs the Cadence build plugin before its elements can be selected and edited.
          <Button
            className="py-0.5! text-xs"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const r = await api.setupCanvasBuild(workspaceId, path);
                setBuild(r.status);
                await load();
              })
            }
          >
            Set up ({build.installed ? "edit config" : "install cadence-build"})
          </Button>
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={wrap} className="relative min-w-0 flex-1">
          {propsFor && <PropsPopover key={propsFor} load={() => api.storyProps(workspaceId, path, propsFor)} name={canvas.storyboards.find((x) => x.id === propsFor)?.name ?? propsFor} onSet={(n, v) => update(() => api.setStoryProp(workspaceId, path, propsFor, n, v))} onClose={() => setPropsFor(null)} />}
          <AgentEditingBanner snapshot={snapshot} workspaceId={workspaceId} path={path} />
          {picked.length > 1 && <ArrangeBar count={picked.length} busy={action.busy} onArrange={(op) => void update(() => api.arrangeStories(workspaceId, path, picked, op))} onClear={() => setPicked([])} />}
          <Board
            view={view}
            onView={setView}
            background={canvas.background}
            cursor={tool === "comment" ? "crosshair" : undefined}
            onBackgroundClick={(x, y) => {
              if (tool === "comment") setDraft({ x, y, storyId: null });
              else if (tool === "select") setSelected(null);
            }}
          >
            {canvas.storyboards.map((s) => (
              <FrameView
                key={`${s.id}:${reloads}`}
                ref={(el) => {
                  frames.current[s.id] = el;
                }}
                story={s}
                src={storySrc(dev, canvas, s, app)}
                notice={s.kind === "route" && dev?.hasPage === false && !canvas.appUrl && !canvas.appCommand ? NO_APP : undefined}
                zoom={view.zoom}
                tool={tool}
                selected={selected?.storyId === s.id}
                picked={picked.includes(s.id)}
                onPick={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                error={errors[s.id] ?? null}
                vrt={vrt?.find((r) => r.storyId === s.id)?.status ?? null}
                onCommit={(frame) => void update(() => api.setFrame(workspaceId, path, s.id, frame))}
                onComment={(x, y) => setDraft({ x, y, storyId: s.id })}
                onMenu={(a) => {
                  if (a === "duplicate") void update(() => api.duplicateStory(workspaceId, path, s.id));
                  if (a === "remove" && confirm(`Delete frame "${s.name}" from ${path}?`)) void update(() => api.removeStory(workspaceId, path, s.id));
                  if (a === "check") void runChecks(s.id);
                  if (a === "open") window.open(storySrc(dev, canvas, s, app) ?? "", "_blank", "noopener");
                  if (a === "lock") void update(() => api.lockStory(workspaceId, path, s.id, !s.locked));
                  if (a === "cover") void update(() => api.setCanvasCover(workspaceId, path, s.id));
                  if (a === "props") setPropsFor(s.id);
                  if (a === "snapshot") void update(() => api.snapshotStory(workspaceId, path, s.id));
                  if (a === "track") void update(() => api.trackVisual(workspaceId, path, s.id, !s.vrt.enabled));
                  if (a === "copy")
                    void action.run(async () => {
                      // The frame rendered fresh, as a PNG on the clipboard.
                      const png = await fetch(`/api/workspaces/${workspaceId}/canvas/screenshot?path=${encodeURIComponent(path)}&story=${encodeURIComponent(s.id)}`).then((r) => (r.ok ? r.blob() : Promise.reject(new Error("Could not render the frame"))));
                      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
                    });
                  if (a === "detach") void action.run(async () => setDetach({ storyId: s.id, storyName: s.name, components: await api.storyComponents(workspaceId, path, s.id) }));
                }}
              />
            ))}
            <CommentsLayer
              comments={pathComments}
              draft={draft}
              snapshot={snapshot}
              zoom={view.zoom}
              showResolved={showResolved}
              onCancelDraft={() => setDraft(null)}
              onCreate={async (body, attachments) => {
                await api.addCanvasComment(workspaceId, { canvasPath: path, storyId: draft!.storyId, x: draft!.x, y: draft!.y, parentId: null, body, attachments });
                setDraft(null);
                setComments(await api.canvasComments(workspaceId));
              }}
              onReply={async (root, body, attachments) => {
                await api.addCanvasComment(workspaceId, { canvasPath: path, storyId: root.storyId, x: root.x, y: root.y, parentId: root.id, body, attachments });
                setComments(await api.canvasComments(workspaceId));
              }}
              moveTargets={snapshot.workspaces.filter((w) => w.id !== workspaceId && !w.archived && w.branch && w.projectId === snapshot.workspaces.find((x) => x.id === workspaceId)?.projectId).map((w) => ({ id: w.id, label: w.branch! }))}
              onEdit={async (id, body) => {
                await api.editCanvasComment(workspaceId, id, body);
                setComments(await api.canvasComments(workspaceId));
              }}
              onMove={async (id, to) => {
                await api.moveCanvasComment(workspaceId, id, to);
                setComments(await api.canvasComments(workspaceId));
              }}
              linkFor={(id) => `${linkOrigin()}${window.location.pathname}#/canvas/${encodeURIComponent(`${workspaceId}|${path}`)}?comment=${id}`}
              initialOpen={new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("comment")}
              onUnread={async (id) => {
                await api.unreadCanvasThread(workspaceId, id);
                setComments(await api.canvasComments(workspaceId));
              }}
              onRead={async (id) => {
                await api.readCanvasThread(workspaceId, id);
                setComments(await api.canvasComments(workspaceId));
              }}
              onReact={async (id, reaction, on) => {
                await api.reactToCanvasComment(workspaceId, id, reaction, on);
                setComments(await api.canvasComments(workspaceId));
              }}
              onResolve={async (id, resolved) => {
                await api.resolveCanvasComment(workspaceId, id, resolved);
                setComments(await api.canvasComments(workspaceId));
              }}
              onDelete={async (id) => {
                await api.deleteCanvasComment(workspaceId, id);
                setComments(await api.canvasComments(workspaceId));
              }}
            />
          </Board>
        </div>
        {chatOpen && <CanvasChatPanel workspaceId={workspaceId} snapshot={snapshot} onClose={() => setChatOpen(false)} />}
        {activityOpen && <ActivityPanel workspaceId={workspaceId} path={path} snapshot={snapshot} onClose={() => setActivityOpen(false)} />}
        {componentsOpen && <ComponentsPanel workspaceId={workspaceId} selectedLoc={selected?.element.loc ?? null} onInserted={() => undefined} onClose={() => setComponentsOpen(false)} />}
        {variablesOpen && <VariablesPanel workspaceId={workspaceId} onClose={() => setVariablesOpen(false)} onChanged={setTokens} />}
        {vrtOpen ? (
          <VrtPanel
            workspaceId={workspaceId}
            path={path}
            stories={canvas.storyboards}
            results={vrt ?? []}
            busy={checking.busy}
            onCheck={() => void runChecks()}
            onAccept={async (storyId) => {
              await api.acceptBaseline(workspaceId, path, storyId);
              await runChecks(storyId);
            }}
            onClose={() => setVrtOpen(false)}
          />
        ) : (
          <InspectPanel
            workspaceId={workspaceId}
            element={selected?.element ?? null}
            tree={story ? (trees[story.id] ?? []) : Object.values(trees)[0] ?? []}
            onPick={(loc) => post(selected?.storyId ?? Object.keys(trees)[0] ?? "", { type: "select", loc })}
            onHover={(loc) => post(selected?.storyId ?? Object.keys(trees)[0] ?? "", { type: "hover", loc })}
            onEdit={async (change) => {
              const r = await api.editElement(workspaceId, selected!.element.loc, change, editContext());
              if (!r.applied) setLedger(await api.canvasLedger(workspaceId));
              return r;
            }}
            ledger={ledger}
            onStage={async (description) => {
              await api.stageEdit(workspaceId, selected!.element.loc, description, editContext());
              setLedger(await api.canvasLedger(workspaceId));
            }}
            onUnstage={async (id) => {
              await api.unstageEdit(workspaceId, id);
              setLedger(await api.canvasLedger(workspaceId));
            }}
            onApplyLedger={async () => {
              const { chatId } = await api.applyLedger(workspaceId);
              setLedger([]);
              navigate("chats", chatId);
            }}
            onLock={async (loc, locked) => {
              await api.lockElement(workspaceId, loc, locked);
              // The page reloads with the new attribute; a locked element can no longer stay selected.
              if (locked && selected?.element.loc === loc) setSelected(null);
            }}
            tokens={tokens}
            root={snapshot.workspaces.find((w) => w.id === workspaceId)?.path}
            onListImages={() => api.repoImages(workspaceId)}
            onUpload={async (file) => {
              const data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
                reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
                reader.readAsDataURL(file);
              });
              return (await api.saveCanvasImage(workspaceId, { name: file.name, mediaType: file.type, data })).url;
            }}
          />
        )}
      </div>
    </div>
  );
}
