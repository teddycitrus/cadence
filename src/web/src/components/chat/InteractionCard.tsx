import { useState } from "react";
import type { Interaction } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";
import { Markdown } from "../Markdown";
import { Button, ErrorText, inputClass, useAction } from "../ui";

function ToolRequest({ it }: { it: Interaction }) {
  const action = useAction();
  const [reason, setReason] = useState("");
  const decide = (allow: boolean, always = false) => action.run(() => api.answer(it.id, { kind: "tool", allow, always, message: reason || undefined }));
  const preview = typeof it.input.command === "string" ? it.input.command : typeof it.input.file_path === "string" ? it.input.file_path : JSON.stringify(it.input, null, 2);
  return (
    <>
      <p className="text-sm">
        Wants to use <span className="font-mono text-amber-200">{it.toolName}</span>
      </p>
      <pre className="max-h-40 overflow-auto rounded bg-zinc-950 p-2 font-mono text-xs text-zinc-300">{preview}</pre>
      <input className="w-full rounded bg-zinc-950 px-2 py-1 text-xs ring-1 ring-zinc-800" placeholder="Reason if denying (sent to the agent)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={action.busy} onClick={() => decide(true)}>
          Allow once
        </Button>
        <Button disabled={action.busy} onClick={() => decide(true, true)}>
          Allow always
        </Button>
        <Button variant="danger" disabled={action.busy} onClick={() => decide(false)}>
          Deny
        </Button>
      </div>
      <ErrorText>{action.error}</ErrorText>
    </>
  );
}

function QuestionRequest({ it }: { it: Interaction }) {
  const action = useAction();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: string, label: string, multi: boolean) =>
    setPicked((p) => {
      const cur = p[q] ?? [];
      return { ...p, [q]: multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] };
    });
  const answers = Object.fromEntries(it.questions.map((q) => [q.question, [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question]!.trim()] : [])].join(", ")]));
  const complete = it.questions.every((q) => answers[q.question]);
  return (
    <>
      {it.questions.map((q) => (
        <div key={q.question} className="space-y-1.5">
          <p className="text-sm">
            {q.header && <span className="mr-2 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{q.header}</span>}
            {q.question}
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {q.options.map((o) => {
              const on = picked[q.question]?.includes(o.label);
              return (
                <button key={o.label} onClick={() => toggle(q.question, o.label, q.multiSelect)} className={`rounded-lg p-2 text-left text-sm ring-1 ${on ? "bg-violet-950/60 ring-violet-500" : "ring-zinc-800 hover:ring-zinc-600"}`}>
                  <span className="block font-medium">{o.label}</span>
                  {o.description && <span className="block text-xs text-zinc-400">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input className={inputClass} placeholder="Other answer" value={other[q.question] ?? ""} onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))} />
        </div>
      ))}
      <Button variant="primary" disabled={!complete || action.busy} onClick={() => action.run(() => api.answer(it.id, { kind: "question", answers }))}>
        Send answers
      </Button>
      <ErrorText>{action.error}</ErrorText>
    </>
  );
}

function PlanRequest({ it }: { it: Interaction }) {
  const action = useAction();
  const [feedback, setFeedback] = useState("");
  return (
    <>
      <p className="text-sm font-medium">Plan ready for review</p>
      <div className="max-h-96 overflow-y-auto rounded-lg bg-zinc-950 px-3 py-1">{it.plan ? <Markdown>{it.plan}</Markdown> : <p className="text-sm text-zinc-500">The plan is in the conversation above.</p>}</div>
      <textarea className={`${inputClass} min-h-14`} placeholder="Feedback if it should keep planning" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={action.busy} onClick={() => action.run(() => api.answer(it.id, { kind: "plan", action: "approve" }))}>
          Approve and build
        </Button>
        <Button
          disabled={action.busy}
          title="Start a new chat with only the plan as context"
          onClick={() =>
            action.run(async () => {
              const res = await api.answer(it.id, { kind: "plan", action: "execute_fresh" });
              if (res.newChatId) navigate("chats", res.newChatId);
            })
          }
        >
          Clear context and build
        </Button>
        <Button variant="ghost" disabled={action.busy || !feedback.trim()} onClick={() => action.run(() => api.answer(it.id, { kind: "plan", action: "revise", feedback }))}>
          Keep planning
        </Button>
      </div>
      <ErrorText>{action.error}</ErrorText>
    </>
  );
}

/** A request an agent is waiting on: approve a tool, answer questions, or review a plan. */
export function InteractionCard({ it, label }: { it: Interaction; label?: string }) {
  if (it.status !== "pending") {
    return (
      <div className="rounded-lg bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400 ring-1 ring-zinc-800">
        {it.kind === "tool" ? `${it.toolName}: ` : it.kind === "question" ? "Answered: " : "Plan: "}
        <span className="whitespace-pre-wrap text-zinc-300">{it.resolution}</span>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg bg-amber-950/30 p-3 ring-1 ring-amber-900/60">
      {label && <p className="text-xs font-medium text-amber-200">{label}</p>}
      {it.kind === "tool" && <ToolRequest it={it} />}
      {it.kind === "question" && <QuestionRequest it={it} />}
      {it.kind === "plan" && <PlanRequest it={it} />}
    </div>
  );
}
