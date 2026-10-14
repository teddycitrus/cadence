import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AGENT_ICONS, type AgentIcon } from "../../../core/agent-icons";
import type { Actor, Agent, Priority, RunStatus, Snapshot, Member } from "../../../core/types";
import { PROVIDERS, providerInfo, type ProviderId } from "../../../core/providers";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-violet-400 text-zinc-900 shadow-sm hover:bg-violet-300 disabled:bg-zinc-700 disabled:text-zinc-500",
  secondary: "bg-zinc-900 text-zinc-200 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-100",
  ghost: "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100",
  danger: "text-red-400 hover:bg-red-950/70",
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

/** Runs an async action with a busy state and surfaces errors inline. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-sm text-red-400">{children}</p>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border-0 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 ring-1 ring-zinc-800 placeholder:text-zinc-500 focus:ring-2 focus:ring-violet-500 focus:outline-none";

export function Dot({ color, className = "size-2.5" }: { color: string; className?: string }) {
  return <span className={`inline-block shrink-0 rounded-full ${className}`} style={{ backgroundColor: color }} />;
}

export function Chip({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800/80 px-2 py-0.5 text-xs text-zinc-300">
      {color && <Dot color={color} className="size-1.5" />}
      {children}
    </span>
  );
}

const PRIORITY: Record<Priority, { label: string; className: string }> = {
  urgent: { label: "Urgent", className: "text-red-400" },
  high: { label: "High", className: "text-orange-400" },
  medium: { label: "Medium", className: "text-yellow-400" },
  low: { label: "Low", className: "text-zinc-400" },
  none: { label: "No priority", className: "text-zinc-600" },
};

export function PriorityIcon({ priority }: { priority: Priority }) {
  const bars = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 }[priority];
  return (
    <span title={PRIORITY[priority].label} className={`inline-flex h-3 items-end gap-px ${PRIORITY[priority].className}`}>
      {[1, 2, 3].map((n) => (
        <span key={n} className={`w-[3px] rounded-sm ${bars >= n ? "bg-current" : "bg-zinc-700"}`} style={{ height: `${n * 4}px` }} />
      ))}
    </span>
  );
}

export const priorityLabel = (p: Priority) => PRIORITY[p].label;

export function AgentAvatar({ agent, size = "size-5" }: { agent: Pick<Agent, "name" | "color" | "icon">; size?: string }) {
  const path = agent.icon ? AGENT_ICONS[agent.icon as AgentIcon] : null;
  return (
    <span title={agent.name} className={`inline-grid shrink-0 place-items-center rounded-md text-[10px] font-semibold text-zinc-950 ${size}`} style={{ backgroundColor: agent.color }}>
      {path ? (
        <svg viewBox="0 0 24 24" className="size-[70%]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d={path} />
        </svg>
      ) : (
        agent.name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

/** A person's initials on their color; without a member it shows the viewer ("Me"). */
export function UserAvatar({ size = "size-5", member }: { size?: string; member?: Pick<Member, "name" | "color"> | null }) {
  const initials = member ? member.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase() : "Me";
  return (
    <span title={member?.name} className={`inline-grid shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white ${size}`} style={{ background: member?.color ?? "#7a3e5a" }}>
      {initials}
    </span>
  );
}

/** The member behind a human actor ("user" is the owner, "member:<id>" a teammate). */
export function memberOf(actor: Actor, snapshot: Partial<Pick<Snapshot, "members">>): Member | null {
  const id = actor === "user" ? "me" : actor.startsWith("member:") ? actor.slice(7) : null;
  return id ? (snapshot.members?.find((m) => m.id === id) ?? null) : null;
}

export function actorName(actor: Actor, snapshot: Pick<Snapshot, "agents"> & Partial<Pick<Snapshot, "chats" | "members" | "viewer">>): string {
  const member = memberOf(actor, snapshot);
  if (member || actor === "user" || actor.startsWith("member:")) {
    if (!snapshot.viewer || member?.id === snapshot.viewer.memberId) return "You";
    return member?.name ?? "Former member";
  }
  if (actor === "system") return "Cadence";
  if (actor.startsWith("agent:")) return snapshot.agents.find((a) => a.id === actor.slice(6))?.name ?? "Deleted agent";
  if (actor.startsWith("token:")) return "Outside agent (MCP)";
  if (actor.startsWith("chat:")) {
    const chat = snapshot.chats?.find((c) => c.id === actor.slice(5));
    return chat ? `AI in "${chat.title}"` : "AI assistant";
  }
  if (actor.startsWith("webhook:")) return "Webhook";
  return actor;
}

const RUN_TONE: Record<RunStatus, string> = {
  queued: "bg-zinc-800 text-zinc-300",
  running: "bg-violet-950 text-violet-300",
  waiting: "bg-amber-950 text-amber-300",
  succeeded: "bg-emerald-950 text-emerald-300",
  failed: "bg-red-950 text-red-300",
  cancelled: "bg-zinc-800 text-zinc-500",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${RUN_TONE[status]}`}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {status === "waiting" ? "needs approval" : status}
    </span>
  );
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center">
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      {children && <div className="mt-1 text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

/** The models a harness offers (what it reported, or its known list), keeping `current` in the list. */
export function modelsFor(snapshot: Pick<Snapshot, "providers">, provider: string, current?: string): string[] {
  const known = snapshot.providers.find((p) => p.id === provider)?.models ?? providerInfo(provider).models;
  return [...new Set([...known, ...(current ? [current] : [])])];
}

/** A harness picker; `disabled` once a chat has started, since a session belongs to one harness. */
export function ProviderSelect({ snapshot, value, onChange, disabled, className }: { snapshot: Pick<Snapshot, "providers">; value: string; onChange: (id: ProviderId) => void; disabled?: boolean; className?: string }) {
  return (
    <select className={className ?? inputClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ProviderId)} title={disabled ? "Start a new chat to use another harness" : "Harness"}>
      {PROVIDERS.map((p) => {
        const s = snapshot.providers.find((x) => x.id === p.id);
        return (
          <option key={p.id} value={p.id}>
            {p.label}
            {s && !s.installed ? " (not installed)" : ""}
          </option>
        );
      })}
    </select>
  );
}
