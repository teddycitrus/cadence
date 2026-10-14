import { useState } from "react";
import { FindingsCard } from "./FindingsCard";
import { IssueToolCard } from "./IssueToolCard";
import type { ChatItem, Interaction, Snapshot, TodoEntry } from "../../../../core/types";
import { Markdown } from "../Markdown";
import { actorName } from "../ui";
import { InteractionCard } from "./InteractionCard";

const BOARD_PREFIX = "mcp__cadence__";
// These tools are shown as their own cards, not as raw tool calls.
const HIDDEN_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"]);

function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return pick("file_path");
    case "Grep":
    case "Glob":
      return `${pick("pattern")} ${pick("path")}`.trim();
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query");
    case "Task":
    case "Agent":
      return pick("description");
    default:
      return Object.values(input)
        .filter((v) => typeof v === "string")
        .join(" · ")
        .slice(0, 120);
  }
}

function EditPreview({ input }: { input: Record<string, unknown> }) {
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") return null;
  return (
    <pre className="overflow-x-auto rounded bg-zinc-950 p-2 font-mono text-[11px] leading-4">
      {input.old_string.split("\n").map((l, i) => (
        <div key={`o${i}`} className="bg-red-950/50 text-red-300">
          - {l}
        </div>
      ))}
      {input.new_string.split("\n").map((l, i) => (
        <div key={`n${i}`} className="bg-emerald-950/50 text-emerald-300">
          + {l}
        </div>
      ))}
    </pre>
  );
}

function ToolCall({ use, result }: { use: Extract<ChatItem, { kind: "tool_use" }>; result?: Extract<ChatItem, { kind: "tool_result" }> }) {
  const [open, setOpen] = useState(false);
  const board = use.name.startsWith(BOARD_PREFIX);
  const name = board ? use.name.slice(BOARD_PREFIX.length) : use.name;
  const pending = !result;
  return (
    <div className="rounded-lg bg-zinc-900/60 text-xs ring-1 ring-zinc-800/80">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <span className={`size-1.5 shrink-0 rounded-full ${pending ? "animate-pulse bg-violet-400" : result?.isError ? "bg-red-400" : "bg-emerald-500"}`} />
        <span className={`font-medium ${board ? "text-violet-300" : "text-zinc-200"}`}>{name}</span>
        <span className="truncate font-mono text-zinc-500">{toolSummary(name, use.input)}</span>
        <span className="ml-auto text-zinc-600">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 p-2.5">
          {(name === "Edit" || name === "MultiEdit") && <EditPreview input={use.input} />}
          {name !== "Edit" && <pre className="max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-zinc-400">{JSON.stringify(use.input, null, 2)}</pre>}
          {result && <pre className={`max-h-72 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] whitespace-pre-wrap ${result.isError ? "text-red-300" : "text-zinc-300"}`}>{result.content || "(no output)"}</pre>}
        </div>
      )}
    </div>
  );
}

export function TodoList({ todos }: { todos: TodoEntry[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="rounded-lg bg-zinc-900/60 p-2.5 text-sm ring-1 ring-zinc-800">
      <p className="mb-1 text-xs text-zinc-500">
        Tasks {done}/{todos.length}
      </p>
      <ul className="space-y-0.5">
        {todos.map((t, i) => (
          <li key={i} className={`flex gap-2 ${t.status === "completed" ? "text-zinc-500 line-through" : t.status === "in_progress" ? "text-zinc-100" : "text-zinc-400"}`}>
            <span>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}</span>
            {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "@src/app.tsx" and "@doc:..." mentions shown as chips. */
function MentionText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(@[\w./:#-]+[\w/])/g).map((part, i) =>
        part.startsWith("@") && part.length > 2 ? (
          <span key={i} className="mx-0.5 rounded bg-zinc-700 px-1 font-mono text-[0.85em] text-violet-200">
            {part.slice(1)}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Several tool calls from a finished turn, folded: what was touched, expandable to each call. */
function ToolGroup({ uses, results }: { uses: Extract<ChatItem, { kind: "tool_use" }>[]; results: Map<string, Extract<ChatItem, { kind: "tool_result" }>> }) {
  const files = [...new Set(uses.filter((u) => EDIT_TOOLS.has(u.name)).map((u) => String(u.input.file_path ?? u.input.notebook_path ?? "")).filter(Boolean))];
  const errors = uses.filter((u) => results.get(u.toolUseId)?.isError).length;
  return (
    <details className="rounded-lg bg-zinc-900/60 text-xs ring-1 ring-zinc-800">
      <summary className="cursor-pointer px-3 py-1.5 text-zinc-400 select-none">
        Used {uses.length} tools
        {files.length > 0 && ` · changed ${files.length} file${files.length === 1 ? "" : "s"}`}
        {errors > 0 && <span className="text-red-400"> · {errors} failed</span>}
      </summary>
      <div className="space-y-2 border-t border-zinc-800 p-2">
        {files.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {files.map((f) => (
              <span key={f} className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
                {f.split(/[\\/]/).slice(-2).join("/")}
              </span>
            ))}
          </p>
        )}
        {uses.map((u) => (
          <ToolCall key={u.seq} use={u} result={results.get(u.toolUseId)} />
        ))}
      </div>
    </details>
  );
}

export function Transcript({ items, interactions, snapshot, streaming, onFork, onRestore, focus = false, workspaceId }: { items: ChatItem[]; interactions: Interaction[]; snapshot: Snapshot; streaming: string; onFork?: (seq: number) => void; onRestore?: (seq: number) => void; focus?: boolean; workspaceId?: string }) {
  // Focus view: each turn shows only the person's message and the last reply.
  const lastReply = new Set<number>();
  if (focus) {
    let last: number | null = null;
    for (const i of items) {
      if (i.kind === "assistant") last = i.seq;
      if (i.kind === "user" || i.kind === "turn") {
        if (last !== null) lastReply.add(last);
        last = null;
      }
    }
    if (last !== null) lastReply.add(last);
  }
  const fork = (seq: number) =>
    onFork && (
      <button className="hidden text-[11px] text-zinc-500 group-hover:inline hover:text-zinc-200" onClick={() => onFork(seq)} title="A new chat with the conversation up to here">
        Fork from here
      </button>
    );
  const results = new Map(items.filter((i): i is Extract<ChatItem, { kind: "tool_result" }> => i.kind === "tool_result").map((r) => [r.toolUseId, r]));
  const byId = new Map(interactions.map((i) => [i.id, i]));
  // A finished turn's tool calls fold into one row; the turn in progress shows them as they happen.
  const lastTurn = items.reduce((n, i, idx) => (i.kind === "turn" ? idx : n), -1);
  const folded = new Map<number, Extract<ChatItem, { kind: "tool_use" }>[]>();
  const hidden = new Set<number>();
  let run: number | null = null;
  items.forEach((item, idx) => {
    // Findings stay visible: they are the point of the turn.
    const tool = item.kind === "tool_use" && !HIDDEN_TOOLS.has(item.name) && !item.name.endsWith("report_findings");
    if (tool && idx < lastTurn) {
      if (run === null) {
        run = idx;
        folded.set(idx, []);
      } else hidden.add(idx);
      folded.get(run)!.push(item as Extract<ChatItem, { kind: "tool_use" }>);
    } else if (item.kind !== "tool_result") run = null;
  });

  return (
    <div className="space-y-3">
      {items.map((item, idx) => {
        if (focus && !(item.kind === "user" || item.kind === "interaction" || item.kind === "notice" || (item.kind === "assistant" && lastReply.has(item.seq)))) return null;
        switch (item.kind) {
          case "user":
            return (
              <div key={item.seq} className="group ml-auto max-w-[85%] space-y-1">
                {item.author !== "user" && <p className="text-right text-xs text-zinc-500">{actorName(item.author, snapshot)}</p>}
                <div className={`rounded-2xl rounded-br-sm px-3.5 py-2 text-sm whitespace-pre-wrap ${item.steer ? "bg-amber-900/40 ring-1 ring-amber-800" : "bg-zinc-800"}`}>
                  {item.steer && <span className="mb-1 block text-xs text-amber-300">Steering</span>}
                  <MentionText text={item.text} />
                </div>
                <p className="space-x-3 text-right">
                  {item.checkpoint && onRestore && (
                    <button className="hidden text-[11px] text-zinc-500 group-hover:inline hover:text-zinc-200" onClick={() => onRestore(item.seq)} title="Put the workspace's files back to how they were just before this message">
                      Restore files
                    </button>
                  )}
                  {fork(item.seq)}
                </p>
                {item.attachments.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {item.attachments.map((a, i) =>
                      a.data && a.mediaType.startsWith("image/") ? (
                        <img key={i} src={`data:${a.mediaType};base64,${a.data}`} alt={a.name} className="max-h-32 rounded-lg ring-1 ring-zinc-700" />
                      ) : (
                        <span key={i} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
                          {a.name}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          case "assistant":
            return (
              <div key={item.seq} className="group max-w-none">
                <Markdown workspaceId={workspaceId}>{item.text}</Markdown>
                {fork(item.seq)}
              </div>
            );
          case "tool_use": {
            if (HIDDEN_TOOLS.has(item.name) || hidden.has(idx)) return null;
            const group = folded.get(idx);
            if (group && group.length > 1) return <ToolGroup key={item.seq} uses={group} results={results} />;
            const result = results.get(item.toolUseId);
            if (item.name.endsWith("report_findings")) return <FindingsCard key={item.seq} input={item.input} />;
            const issueTool = /issues_(create|get|update|move)$/.test(item.name) && result && !result.isError;
            return (
              <div key={item.seq}>
                <ToolCall use={item} result={result} />
                {issueTool && <IssueToolCard text={result.content} snapshot={snapshot} />}
              </div>
            );
          }
          case "tool_result":
            return null;
          case "todo":
            return <TodoList key={item.seq} todos={item.todos} />;
          case "interaction": {
            const it = byId.get(item.interactionId);
            return it ? <InteractionCard key={item.seq} it={it} /> : null;
          }
          case "notice":
            return (
              <p key={item.seq} className={`text-center text-xs ${item.tone === "error" ? "text-red-400" : item.tone === "warn" ? "text-amber-300" : "text-zinc-500"}`}>
                {item.text}
              </p>
            );
          case "turn":
            return (
              <p key={item.seq} className="flex items-center gap-2 text-[11px] text-zinc-600">
                <span className="h-px flex-1 bg-zinc-900" />
                {item.isError ? <span className="text-red-400">{item.error}</span> : null}
                {(item.durationMs / 1000).toFixed(1)}s · {item.numTurns} steps · {((item.inputTokens + item.outputTokens) / 1000).toFixed(1)}k tokens · ${item.costUsd.toFixed(3)}
                <span className="h-px flex-1 bg-zinc-900" />
              </p>
            );
        }
      })}
      {streaming && (
        <div className="opacity-90">
          <Markdown workspaceId={workspaceId}>{streaming}</Markdown>
          <span className="inline-block h-4 w-1.5 animate-pulse bg-zinc-400 align-middle" />
        </div>
      )}
    </div>
  );
}
