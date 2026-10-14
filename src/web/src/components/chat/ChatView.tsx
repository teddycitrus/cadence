import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { navigate } from "../../App";
import { FindBar } from "./FindBar";
import { BranchPicker } from "./BranchPicker";
import { ArtifactStrip } from "./ArtifactStrip";
import { BackgroundTasks } from "./BackgroundTasks";
import type { ChatItem, QueuedMessage, Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { useChat, useStreamingText } from "../../live";
import { Button, ErrorText, inputClass, useAction } from "../ui";
import { Composer } from "./Composer";
import { TodoList, Transcript } from "./Transcript";
import { ProviderSignIn } from "../settings/ProviderSignIn";
import { isProviderId, providerInfo } from "../../../../core/providers";

// Only chats switched to the terminal (CLI mode) need xterm.
const TerminalView = lazy(() => import("../terminal/TerminalPanel").then((m) => ({ default: m.TerminalView })));

function QueuedRow({ chatId, message }: { chatId: string; message: QueuedMessage }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.text);
  const action = useAction();
  return (
    <div className="rounded-lg bg-zinc-900 p-2 text-sm ring-1 ring-zinc-800">
      {editing ? (
        <div className="space-y-1.5">
          <textarea className={`${inputClass} min-h-14`} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-1">
            <Button variant="primary" onClick={async () => (await action.run(() => api.editQueued(chatId, message.id, text))) && setEditing(false)}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <span className="mt-0.5 rounded bg-zinc-800 px-1.5 text-[10px] tracking-wide text-zinc-400 uppercase">queued</span>
          <p className="min-w-0 flex-1 whitespace-pre-wrap text-zinc-300">{message.text}</p>
          <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="text-xs text-amber-300 hover:text-amber-200" onClick={() => action.run(() => api.sendQueuedNow(chatId, message.id))} title="Send into the running turn now">
            Nudge now
          </button>
          <button className="text-xs text-zinc-500 hover:text-red-400" onClick={() => action.run(() => api.removeQueued(chatId, message.id))}>
            Remove
          </button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}



export function ChatView({ chatId, snapshot }: { chatId: string; snapshot: Snapshot }) {
  const { data, error, loadEarlier } = useChat(chatId);
  const earlierAction = useAction();
  const [focus, setFocus] = useState(false);
  const streaming = useStreamingText(chatId);
  const scroller = useRef<HTMLDivElement>(null);
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    // Ctrl+F finds in the chat (the browser's own find still works on a second press).
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !finding && !e.defaultPrevented) {
        e.preventDefault();
        setFinding(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finding]);
  const pinned = useRef(true);
  const chat = snapshot.chats.find((c) => c.id === chatId) ?? data?.chat;
  const [cli, setCli] = useState<{ active: boolean; terminalId: string | null; available: boolean } | null>(null);
  const cliAction = useAction();
  useEffect(() => {
    api.cliStatus(chatId).then(setCli, () => setCli(null));
  }, [chatId]);

  useEffect(() => {
    if (chat?.unread) void api.markRead(chatId);
  }, [chatId, chat?.unread, data?.items.length]);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [data?.items.length, streaming, data?.interactions.length]);

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!data || !chat) return <div className="flex-1" />;

  if (cli?.active && cli.terminalId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-zinc-900 px-4 py-1.5 text-xs text-zinc-400">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          <span className="flex-1">CLI mode: the {chat.provider} terminal UI on this chat's session. Its turns come back into the chat when you switch.</span>
          <Button
            className="py-1! text-xs"
            disabled={cliAction.busy}
            onClick={() =>
              cliAction.run(async () => {
                await api.exitCli(chatId);
                setCli({ ...cli, active: false, terminalId: null });
              })
            }
          >
            {cliAction.busy ? "Bringing it back..." : "Back to chat"}
          </Button>
        </div>
        <ErrorText>{cliAction.error}</ErrorText>
        <Suspense fallback={<p className="p-4 text-sm text-zinc-500">Loading the terminal...</p>}>
          <TerminalView key={cli.terminalId} term={{ id: cli.terminalId, alive: true, exitCode: null }} visible />
        </Suspense>
      </div>
    );
  }

  const latestTodo = [...data.items].reverse().find((i): i is Extract<ChatItem, { kind: "todo" }> => i.kind === "todo");
  // The last turn failed because the harness is signed out: offer its login in a terminal.
  const lastTurn = [...data.items].reverse().find((i): i is Extract<ChatItem, { kind: "turn" }> => i.kind === "turn");
  const signedOut = lastTurn?.isError && /\/login|log ?in|authenticat|unauthori[sz]ed|invalid api key|api key|401|expired/i.test(lastTurn.error ?? "");
  const agent = chat.agentId ? snapshot.agents.find((a) => a.id === chat.agentId) : null;
  const running = chat.status === "running" || chat.status === "waiting";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-chat-view>
      <ArtifactStrip chat={chat} snapshot={snapshot} />
      {finding && <FindBar scope={scroller} onClose={() => setFinding(false)} />}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto max-w-3xl">
          {data.items.length === 0 && (
            <div className="py-16 text-center">
              <p className="font-display text-2xl">{agent ? `${agent.name}'s chat` : "What should we work on?"}</p>
              <p className="mt-1 text-sm text-zinc-500">Ask for a change, a plan, or an explanation. Mention files, docs, and issues with @.</p>
            </div>
          )}
          {data.earlier && (
            <p className="mb-4 text-center">
              <button className="text-xs text-violet-300 hover:underline disabled:opacity-50" disabled={earlierAction.busy} onClick={() => void earlierAction.run(loadEarlier)}>
                {earlierAction.busy ? "Loading..." : "Load earlier messages"}
              </button>
            </p>
          )}
          <Transcript
            workspaceId={chat.workspaceId}
            onRestore={(seq) => confirm("Put this workspace's files back to how they were just before this message? Changes made since then are lost (commits are kept).") && void earlierAction.run(() => api.restoreFiles(chatId, seq))}
            focus={focus}
            onFork={chat.docId ? undefined : (seq) => void earlierAction.run(async () => navigate("chats", (await api.forkChat(chatId, seq)).id))} items={data.items} interactions={data.interactions} snapshot={snapshot} streaming={streaming} />
          {running && !streaming && (
            <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
              <span className="size-1.5 animate-pulse rounded-full bg-violet-400" />
              {chat.status === "waiting" ? "Waiting for you" : "Working"}
            </p>
          )}
          {chat.status === "interrupted" && <p className="mt-3 text-xs text-zinc-500">Stopped. Send a message to continue where it left off.</p>}
          {chat.status === "error" && <p className="mt-3 text-xs text-red-400">The session ended with an error. Send a message to resume.</p>}
        </div>
      </div>
      <div className="border-t border-zinc-900 px-6 py-3">
        <div className="mx-auto max-w-3xl space-y-2">
          {signedOut && (
            <div className="space-y-2 rounded-lg bg-amber-950/40 px-3 py-2 text-xs ring-1 ring-amber-900">
              <p className="text-amber-200">
                {providerInfo(chat.provider).label} needs you to sign in again{snapshot.viewer.role === "member" ? "; ask an admin to sign it in or add a key in Settings > Providers." : " (or add a key in Settings > Providers)."}
              </p>
              {snapshot.viewer.role !== "member" && isProviderId(chat.provider) && <ProviderSignIn provider={chat.provider} onDone={() => undefined} />}
            </div>
          )}
          {latestTodo && running && <TodoList todos={latestTodo.todos} />}
          {data.queued.map((m) => (
            <QueuedRow key={m.id} chatId={chatId} message={m} />
          ))}
          <Composer chat={data?.chat ? { ...chat, slashCommands: data.chat.slashCommands, commandHints: data.chat.commandHints } : chat} snapshot={snapshot} workspaceId={chat.workspaceId} />
          <ErrorText>{cliAction.error}</ErrorText>
          <p className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-right text-[11px] whitespace-nowrap text-zinc-600">
            <span className="mr-auto">
              <BackgroundTasks items={data.items} />
            </span>
            {(() => {
              const ws = snapshot.workspaces.find((w) => w.id === chat.workspaceId);
              return ws?.branch ? <BranchPicker ws={ws} disabled={running} /> : null;
            })()}
            {cli?.available && (
              <button
                className="text-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                disabled={running || cliAction.busy}
                title={running ? "Wait for the turn to finish" : "Continue this session in the harness's own terminal UI"}
                onClick={() => cliAction.run(async () => setCli(await api.enterCli(chatId)))}
              >
                {">_ Open in CLI"}
              </button>
            )}
            <button className={focus ? "text-sky-300" : "text-zinc-500 hover:text-zinc-100"} onClick={() => setFocus(!focus)} title="Focus view: only your messages and each turn's final reply">
              Focus
            </button>
            <button
              className="text-zinc-500 hover:text-zinc-100"
              onClick={() => {
                const reply = [...data.items].reverse().find((i) => i.kind === "assistant");
                if (reply && reply.kind === "assistant") void navigator.clipboard.writeText(reply.text);
              }}
              title="Copy the last reply"
            >
              Copy reply
            </button>
            {chat.provider === "claude-code" && !running && data.items.length > 0 && (
              <button className="text-zinc-500 hover:text-zinc-100" onClick={() => void earlierAction.run(() => api.sendMessage(chatId, { text: "/compact", attachments: [], mentions: [], steer: false }))} title="Summarize the conversation so far to free up context">
                Compact
              </button>
            )}
            <a className="text-zinc-500 hover:text-zinc-100" href={`/api/chats/${chatId}/export`} download title="Download this conversation as Markdown">
              Export
            </a>
            <span>
            {chat.provider} · {((chat.inputTokens + chat.outputTokens) / 1000).toFixed(1)}k tokens · ${chat.costUsd.toFixed(2)}
            </span>
            {lastTurn?.contextTokens && lastTurn.contextWindow ? (
              <span title={`${lastTurn.contextTokens.toLocaleString()} of ${lastTurn.contextWindow.toLocaleString()} tokens in context`} className={lastTurn.contextTokens / lastTurn.contextWindow > 0.8 ? "text-amber-400" : undefined}>
                Context {Math.round((lastTurn.contextTokens / lastTurn.contextWindow) * 100)}% used
              </span>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}
