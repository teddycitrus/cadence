import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { starterPrompt } from "../../../../projects/templates";
import { McpMenu } from "./McpMenu";
import type { Attachment, Chat, ChatMode, Snapshot } from "../../../../core/types";
import { EFFORTS } from "../../../../core/types";
import { api, type MessageInput } from "../../api";
import { Button, ErrorText, modelsFor, ProviderSelect, useAction } from "../ui";
import { COMPOSER_CONTEXT_EVENT, takeComposerContext } from "./composer-context";

let builtins: Promise<{ name: string; title: string; argumentHint: string }[]> | null = null;
/** The built-in workflows, fetched once per page load. */
const loadBuiltins = () => (builtins ??= api.builtinSkills().catch(() => ((builtins = null), [])));

type Mention = MessageInput["mentions"][number];
interface Suggestion {
  kind: Mention["kind"] | "command";
  ref: string;
  label: string;
  hint: string;
}

export const MODES: { value: ChatMode; label: string; hint: string }[] = [
  { value: "default", label: "Ask first", hint: "Asks before edits and commands" },
  { value: "acceptEdits", label: "Edit files", hint: "Edits freely, asks before commands" },
  { value: "plan", label: "Plan", hint: "Read-only; proposes a plan for approval" },
  { value: "bypassPermissions", label: "Full access", hint: "Never asks" },
];

const MAX_TEXT_FILE = 1_000_000;

function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    if (file.type.startsWith("image/")) {
      reader.onload = () => resolve({ name: file.name || "pasted-image.png", mediaType: file.type, data: String(reader.result).split(",")[1] ?? "" });
      reader.readAsDataURL(file);
    } else {
      if (file.size > MAX_TEXT_FILE) return reject(new Error(`${file.name} is too large to attach as text`));
      reader.onload = () => resolve({ name: file.name, mediaType: file.type || "text/plain", text: String(reader.result) });
      reader.readAsText(file);
    }
  });
}

/** The active "@foo" or "/foo" token right before the cursor, if any. */
function activeToken(text: string, cursor: number): { trigger: "@" | "/"; query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { trigger: "@", query: at[2]!, start: cursor - at[2]!.length - 1 };
  const slash = /^\/([\w:-]*)$/.exec(before);
  if (slash) return { trigger: "/", query: slash[1]!, start: 0 };
  return null;
}

export function Composer({ chat, snapshot, workspaceId }: { chat: Chat; snapshot: Snapshot; workspaceId: string }) {
  const [text, setText] = useState(() => takeComposerContext(workspaceId));
  // A canvas selection sent to this workspace's chat lands in the message being written.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== workspaceId) return;
      const extra = takeComposerContext(workspaceId);
      if (!extra) return;
      setText((t) => (t.trim() ? `${t.trimEnd()}\n${extra}` : extra));
      area.current?.focus();
    };
    window.addEventListener(COMPOSER_CONTEXT_EVENT, on);
    return () => window.removeEventListener(COMPOSER_CONTEXT_EVENT, on);
  }, [workspaceId]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const action = useAction();
  const running = chat.status === "running" || chat.status === "waiting";
  // A session belongs to one harness; the server has the final say.
  const started = Boolean(chat.sessionId) || running;

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const refreshSuggestions = async (value: string, cursor: number) => {
    const token = activeToken(value, cursor);
    if (!token) return setSuggestions([]);
    const needle = token.query.toLowerCase();
    if (token.trigger === "/") {
      // Cadence's own workflows first, then the harness's commands (a workflow name hides a harness command of the same name).
      const builtin = (await loadBuiltins()).filter((s) => `${s.name} ${s.title}`.toLowerCase().includes(needle)).slice(0, 8);
      const names = new Set(builtin.map((s) => s.name));
      const commands = chat.slashCommands.filter((c) => !names.has(c) && `${c} ${chat.commandHints?.[c] ?? ""}`.toLowerCase().includes(needle)).slice(0, Math.max(0, 8 - builtin.length));
      setHighlight(0);
      return setSuggestions([...builtin.map((s) => ({ kind: "command" as const, ref: s.name, label: `/${s.name}`, hint: s.argumentHint ? `${s.title} ${s.argumentHint}` : s.title })), ...commands.map((c) => ({ kind: "command" as const, ref: c, label: `/${c}`, hint: chat.commandHints?.[c] ?? "command" }))]);
    }
    const docs = snapshot.docs.filter((d) => d.title.toLowerCase().includes(needle)).slice(0, 4).map((d) => ({ kind: "doc" as const, ref: d.id, label: d.title, hint: "doc" }));
    const issues = snapshot.issues
      .filter((i) => `${i.key} ${i.title}`.toLowerCase().includes(needle))
      .slice(0, 4)
      .map((i) => ({ kind: "issue" as const, ref: i.id, label: `${i.key} ${i.title}`, hint: "issue" }));
    const files = needle.length >= 1 ? (await api.workspaceFiles(workspaceId, token.query).catch(() => ({ files: [] }))).files.slice(0, 8) : [];
    setSuggestions([...files.map((f) => ({ kind: "file" as const, ref: f, label: f, hint: "file" })), ...issues, ...docs]);
    setHighlight(0);
  };

  const choose = (s: Suggestion) => {
    const cursor = area.current?.selectionStart ?? text.length;
    const token = activeToken(text, cursor);
    if (!token) return;
    const insert = s.kind === "command" ? `/${s.ref} ` : `@${s.kind === "file" ? s.ref : s.label} `;
    setText(text.slice(0, token.start) + insert + text.slice(cursor));
    if (s.kind !== "command") setMentions((m) => (m.some((x) => x.kind === s.kind && x.ref === s.ref) ? m : [...m, { kind: s.kind as Mention["kind"], ref: s.ref }]));
    setSuggestions([]);
    area.current?.focus();
  };

  const addFiles = (files: FileList | File[]) =>
    action.run(async () => {
      const read = await Promise.all([...files].map(readFile));
      setAttachments((a) => [...a, ...read].slice(0, 10));
    });

  const send = (steer: boolean) =>
    action.run(async () => {
      if (!text.trim() && !attachments.length) return;
      await api.sendMessage(chat.id, { text, attachments, mentions, steer });
      setText("");
      setAttachments([]);
      setMentions([]);
    });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === "ArrowDown") return (e.preventDefault(), setHighlight((h) => (h + 1) % suggestions.length));
      if (e.key === "ArrowUp") return (e.preventDefault(), setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length));
      if (e.key === "Enter" || e.key === "Tab") return (e.preventDefault(), choose(suggestions[highlight]!));
      if (e.key === "Escape") return setSuggestions([]);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(false);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (images.length) {
      e.preventDefault();
      void addFiles(images);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  };

  const patch = (p: Parameters<typeof api.updateChat>[1]) => action.run(() => api.updateChat(chat.id, p));
  const select = "rounded-md bg-transparent px-1.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 focus:outline-none";

  return (
    <div
      className={`relative rounded-xl bg-zinc-900 ring-1 transition ${dragging ? "ring-violet-500" : "ring-zinc-800 focus-within:ring-zinc-600"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {suggestions.length > 0 && (
        <ul className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-full overflow-y-auto rounded-lg bg-zinc-900 p-1 shadow-2xl ring-1 ring-zinc-700">
          {suggestions.map((s, i) => (
            <li key={`${s.kind}:${s.ref}`}>
              <button onMouseDown={(e) => (e.preventDefault(), choose(s))} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${i === highlight ? "bg-zinc-800" : ""}`}>
                <span className="w-12 shrink-0 text-xs text-zinc-500">{s.hint}</span>
                <span className="truncate">{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {attachments.map((a, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-lg bg-zinc-800 py-1 pr-1 pl-1 text-xs">
              {a.data ? <img src={`data:${a.mediaType};base64,${a.data}`} alt="" className="size-8 rounded object-cover" /> : <span className="rounded bg-zinc-700 px-1 text-[10px] text-zinc-300">FILE</span>}
              <span className="max-w-40 truncate">{a.name}</span>
              <button className="px-1 text-zinc-500 hover:text-zinc-100" onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))} aria-label={`Remove ${a.name}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        rows={1}
        className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm placeholder:text-zinc-500 focus:outline-none"
        placeholder={running ? "Message is queued until this turn ends, or steer it now" : "Ask anything. @ to add files, docs and issues, / for commands"}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          void refreshSuggestions(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => setTimeout(() => setSuggestions([]), 150)}
      />
      <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
        <button className="rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800" title="Attach files or images" onClick={() => fileInput.current?.click()}>
          +
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
        <select className={select} value={chat.mode} onChange={(e) => patch({ mode: e.target.value as ChatMode })} title={MODES.find((m) => m.value === chat.mode)?.hint}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {!chat.agentId && <ProviderSelect className={select} snapshot={snapshot} value={chat.provider} disabled={started} onChange={(provider) => patch({ provider })} />}
        <select className={select} value={chat.model} onChange={(e) => patch({ model: e.target.value })} title="Model">
          {modelsFor(snapshot, chat.provider, chat.model).map((m) => (
            <option key={m} value={m}>
              {m === "default" ? "Harness default" : m}
            </option>
          ))}
        </select>
        <select className={select} value={chat.effort} onChange={(e) => patch({ effort: e.target.value as Chat["effort"] })} title="Effort">
          {EFFORTS.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
        <McpMenu chat={chat} onChange={(mcpServers) => patch({ mcpServers })} />
        <select
          className={select}
          value=""
          title="Generate a design or a working prototype from what you typed"
          onChange={(e) => {
            const kind = e.target.value as "mockup" | "prototype";
            if (kind) setText(starterPrompt(kind, text || "the idea we discussed"));
          }}
        >
          <option value="">Generate...</option>
          <option value="mockup">Sketch a static design</option>
          <option value="prototype">Build a working app</option>
        </select>
        {chat.provider === "claude-code" && (
          <button
            className={`rounded-md px-2 py-1 text-xs ring-1 ${chat.fast ? "bg-amber-950 text-amber-300 ring-amber-800" : "text-zinc-500 ring-zinc-800 hover:text-zinc-300"}`}
            onClick={() => patch({ fast: !chat.fast })}
            title="Fast mode: the same model with faster output, billed at a higher rate. Applies from the next turn."
          >
            Fast
          </button>
        )}
        {chat.provider === "claude-code" && (
          <button
            className={`rounded-md px-2 py-1 text-xs ring-1 ${chat.remoteControl ? "bg-sky-950 text-sky-300 ring-sky-800" : "text-zinc-500 ring-zinc-800 hover:text-zinc-300"}`}
            onClick={() => patch({ remoteControl: !chat.remoteControl })}
            title="Remote Control: also drive this session from claude.ai/code or the Claude app. Applies from the next turn."
          >
            Remote
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {running && (
            <>
              <Button variant="ghost" disabled={action.busy || !text.trim()} onClick={() => send(true)} title="Send into the turn that is running now">
                Nudge
              </Button>
              <Button variant="danger" onClick={() => action.run(() => api.interrupt(chat.id))}>
                Stop
              </Button>
            </>
          )}
          <Button variant="primary" disabled={action.busy || (!text.trim() && !attachments.length)} onClick={() => send(false)}>
            {running ? "Queue" : "Send"}
          </Button>
        </div>
      </div>
      {action.error && (
        <div className="px-3 pb-2">
          <ErrorText>{action.error}</ErrorText>
        </div>
      )}
    </div>
  );
}
