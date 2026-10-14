import { useEffect, useState } from "react";
import type { Snapshot } from "../../../../core/types";
import { api, type StarterTaskInfo } from "../../api";
import { navigate } from "../../App";
import { orgParam } from "../../org";
import { Button, ErrorText, inputClass, useAction } from "../ui";
import { Generate, ImportRepo, OpenFolder } from "./HomeView";
import { Requirements } from "./Requirements";
import { ConnectAccounts } from "./ConnectAccounts";
import { openWelcome } from "./welcome";
export { needsOnboarding } from "./needs-onboarding";

const ROLES = [
  { id: "engineer", label: "Engineer" },
  { id: "designer", label: "Designer" },
  { id: "product", label: "Product manager" },
  { id: "founder", label: "Founder" },
  { id: "other", label: "Something else" },
] as const;

type Step = "role" | "setup" | "connect" | "project" | "team" | "agents";

/** Whether someone should see onboarding: once, and for the owner only while there is nothing here yet. */
function Dots({ step, steps }: { step: Step; steps: Step[] }) {
  return (
    <div className="flex gap-1.5">
      {steps.map((s) => (
        <span key={s} className={`h-1.5 w-8 rounded-full ${steps.indexOf(s) <= steps.indexOf(step) ? "bg-violet-500" : "bg-zinc-800"}`} />
      ))}
    </div>
  );
}

function Invite() {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const action = useAction();
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input className={inputClass} type="email" placeholder="teammate@company.com (or leave empty for a link)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button
          variant="primary"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              const r = await api.createInvite("member", email.trim() || undefined);
              if (r.emailed) setSent((s) => [...s, email.trim()]);
              else setLink(`${window.location.origin}/#/invite/${r.token}${orgParam()}`);
              setEmail("");
            })
          }
        >
          {email.trim() ? "Send invite" : "Create link"}
        </Button>
      </div>
      {sent.length > 0 && <p className="text-sm text-emerald-400">Invited {sent.join(", ")}.</p>}
      {link && (
        <p className="flex gap-2 rounded-md bg-zinc-900 p-2 text-xs ring-1 ring-zinc-800">
          <code className="min-w-0 flex-1 truncate">{link}</code>
          <button className="text-zinc-300 hover:text-zinc-50" onClick={() => void navigator.clipboard.writeText(link)}>
            Copy
          </button>
        </p>
      )}
      <p className="text-xs text-zinc-500">Invites work once, for 7 days. Sending by email needs a mail server under Settings &gt; Members; links work without one.</p>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

function StarterTasks({ snapshot, projectId, onStarted }: { snapshot: Snapshot; projectId: string | null; onStarted: () => void }) {
  const [tasks, setTasks] = useState<StarterTaskInfo[]>([]);
  const [project, setProject] = useState(projectId ?? snapshot.projects[0]?.id ?? "");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [started, setStarted] = useState<Record<string, string>>({});
  // Per task: an edited prompt (once opened), and the model and effort to run with.
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [model, setModel] = useState(snapshot.settings.defaultModel);
  const [effort, setEffort] = useState(snapshot.settings.defaultEffort);
  const models = snapshot.providers.find((p) => p.id === (snapshot.settings.defaultProvider ?? "claude-code"))?.models ?? [];
  const action = useAction();
  useEffect(() => {
    api.starterTasks().then(setTasks, () => undefined);
  }, []);
  if (!snapshot.projects.length) return <p className="text-sm text-zinc-500">Add a project first; these agents work in one.</p>;
  return (
    <div className="space-y-3">
      <select className={`${inputClass} w-auto`} value={project} onChange={(e) => setProject(e.target.value)}>
        {snapshot.projects.map((p) => (
          <option key={p.id} value={p.id}>
            In {p.name}
          </option>
        ))}
      </select>
      <div className="flex gap-2 text-xs">
        <select className={`${inputClass} w-auto py-1! text-xs`} value={model} onChange={(e) => setModel(e.target.value)} title="Model for these agents">
          {[...new Set([model, ...models])].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <select className={`${inputClass} w-auto py-1! text-xs`} value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)} title="Effort">
          {(["low", "medium", "high", "xhigh", "max"] as const).map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {tasks.map((t) => (
          <div key={t.id} className="flex flex-col gap-2 rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800">
            <p className="font-display text-lg">{t.title}</p>
            <p className="text-sm text-zinc-400">{t.description}</p>
            <p className="text-xs text-zinc-500">
              About {t.minutes} min · {t.tokens} tokens
            </p>
            {t.needsNote && <input className={inputClass} placeholder="Which feature?" value={notes[t.id] ?? ""} onChange={(e) => setNotes({ ...notes, [t.id]: e.target.value })} />}
            {prompts[t.id] !== undefined ? (
              <textarea className={`${inputClass} min-h-40 font-mono text-[11px]`} value={prompts[t.id]} onChange={(e) => setPrompts({ ...prompts, [t.id]: e.target.value })} />
            ) : (
              !started[t.id] && (
                <button className="self-start text-xs text-zinc-500 hover:text-zinc-200" onClick={() => void action.run(async () => setPrompts({ ...prompts, [t.id]: (await api.starterPrompt(t.id, notes[t.id] ?? "")).prompt }))}>
                  Edit prompt
                </button>
              )
            )}
            {started[t.id] ? (
              <a href={`#/chats/${started[t.id]}`} className="mt-auto text-sm text-violet-300 hover:underline" onClick={onStarted}>
                Running: open its chat
              </a>
            ) : (
              <Button
                className="mt-auto self-start"
                disabled={action.busy || (t.needsNote && !(notes[t.id] ?? "").trim() && !prompts[t.id]?.trim())}
                onClick={() =>
                  action.run(async () => {
                    const r = await api.startTask({ task: t.id, projectId: project, note: notes[t.id] ?? "", prompt: prompts[t.id], model, effort });
                    setStarted((s) => ({ ...s, [t.id]: r.chatId }));
                  })
                }
              >
                Start
              </Button>
            )}
          </div>
        ))}
      </div>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

/** First run: what you do, this computer's tools, your accounts and keys, a project, your team, and your first agents. Every step can be skipped. */
export function Onboarding({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const admin = snapshot.viewer.role !== "member";
  // The machine checks are for whoever runs Cadence; teammates in a browser skip them.
  const steps: Step[] = admin ? ["role", "setup", "connect", "project", "team", "agents"] : ["role"];
  const [step, setStep] = useState<Step>("role");
  // Someone who left part way through picks up with their answer already chosen.
  const [role, setRole] = useState<string | null>(() => snapshot.members.find((m) => m.id === snapshot.viewer.memberId)?.jobRole ?? null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const action = useAction();
  const next = () => {
    const i = steps.indexOf(step);
    if (i < steps.length - 1) setStep(steps[i + 1]!);
    else void finish();
  };
  // The tour ends in a Welcome workspace: its chat, with the tour canvas beside it.
  const finish = () =>
    action.run(async () => {
      await api.setOnboarding({ done: true });
      onClose();
      await openWelcome(projectId);
    });

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-zinc-950">
      <div className="mx-auto max-w-3xl space-y-8 px-8 py-14">
        <div className="flex items-center justify-between">
          <Dots step={step} steps={steps} />
          <button className="text-sm text-zinc-500 hover:text-zinc-200" onClick={() => void finish()}>
            Skip setup
          </button>
        </div>
        {step === "role" && (
          <section className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight">Welcome to Cadence</h1>
            <p className="text-zinc-400">What do you do? Agents and templates are tuned to how you work.</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {ROLES.map((r) => (
                <button key={r.id} onClick={() => setRole(r.id)} className={`rounded-lg p-3 text-left ring-1 ${role === r.id ? "bg-violet-950/40 ring-violet-600" : "bg-zinc-900 ring-zinc-800 hover:ring-zinc-600"}`}>
                  {r.label}
                </button>
              ))}
            </div>
            <Button variant="primary" disabled={!role || action.busy} onClick={() => action.run(async () => (await api.setOnboarding({ jobRole: role! }), next()))}>
              Continue
            </Button>
          </section>
        )}
        {step === "setup" && (
          <section className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight">Check your setup</h1>
            <p className="text-zinc-400">Cadence builds on tools already on this computer.</p>
            <Requirements onContinue={next} />
          </section>
        )}
        {step === "connect" && (
          <section className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight">Connect your accounts</h1>
            <p className="text-zinc-400">Cadence runs on your own logins and keys. Connect at least one AI model; the rest can wait.</p>
            <ConnectAccounts snapshot={snapshot} />
            <Button variant="primary" onClick={next}>
              Continue
            </Button>
          </section>
        )}
        {step === "project" && (
          <section className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight">Bring a project</h1>
            <p className="text-zinc-400">Start something new, or point Cadence at code you already have. Each issue and agent gets its own branch of it.</p>
            <Generate snapshot={snapshot} onDone={(r) => (setProjectId(r.projectId), next())} />
            <div className="grid gap-4 sm:grid-cols-2">
              <OpenFolder onDone={next} />
              <ImportRepo onDone={next} />
            </div>
            <button className="text-sm text-zinc-500 hover:text-zinc-200" onClick={next}>
              {snapshot.projects.length ? "Continue with my projects" : "Skip for now"}
            </button>
          </section>
        )}
        {step === "team" && (
          <section className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight">Invite your team</h1>
            <p className="text-zinc-400">Teammates work the board, docs, and canvases with you. Make them admins later if they should run agents too.</p>
            <Invite />
            <Button variant="primary" onClick={next}>
              Continue
            </Button>
          </section>
        )}
        {step === "agents" && (
          <section className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight">Start your first agents</h1>
            <p className="text-zinc-400">Each runs in its own workspace. Watch them in Chats, or come back later.</p>
            <StarterTasks snapshot={snapshot} projectId={projectId} onStarted={() => void finish()} />
            <Button variant="primary" disabled={action.busy} onClick={() => void finish()}>
              Done
            </Button>
          </section>
        )}
        <ErrorText>{action.error}</ErrorText>
      </div>
    </div>
  );
}
