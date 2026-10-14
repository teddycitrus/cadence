import { useEffect, useState } from "react";
import type { Snapshot } from "../../../../core/types";
import { api, type MachineLinkStatus, type MachineSummary, type MachineView } from "../../api";
import { Button, ErrorText, Field, inputClass, timeAgo, useAction } from "../ui";

/** What is running and waiting on one machine, with approvals answered from here. */
function MachineActivity({ machine }: { machine: MachineView }) {
  const [summary, setSummary] = useState<MachineSummary | null>(null);
  const action = useAction();
  const load = () => api.machineSummary(machine.id).then(setSummary, (e: Error) => action.setError(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [machine.id]);
  if (!summary) return <ErrorText>{action.error}</ErrorText>;
  return (
    <div className="space-y-2 border-t border-zinc-900 pt-2 text-xs">
      <div className="flex items-center gap-2">
        <select
          className="rounded bg-zinc-900 px-2 py-0.5 text-zinc-300 ring-1 ring-zinc-800"
          value=""
          onChange={(e) => {
            const projectId = e.target.value === "none" ? null : e.target.value;
            if (!e.target.value) return;
            const name = prompt("New workspace on this machine", "New work");
            if (name?.trim())
              void action.run(async () => {
                const made = await api.createMachineWorkspace(machine.id, { projectId, name: name.trim() });
                window.open(`${(await api.openMachine(machine.id)).url}#/chats/${made.chatId}`, "_blank", "noopener");
                await load();
              });
          }}
        >
          <option value="">New workspace in...</option>
          {summary.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="none">No project (a scratch folder)</option>
        </select>
      </div>
      {summary.recent.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {summary.recent.map((w) => (
            <button
              key={w.id}
              className="rounded bg-zinc-900 px-2 py-0.5 text-zinc-300 ring-1 ring-zinc-800 hover:ring-zinc-600"
              title={w.branch ?? undefined}
              onClick={() => void action.run(async () => window.open(`${(await api.openMachine(machine.id)).url}#/chats${w.chatId ? `/${w.chatId}` : ""}`, "_blank", "noopener"))}
            >
              {w.name}
            </button>
          ))}
        </div>
      )}
      <p className="text-zinc-500">
        {summary.workspaces} workspace{summary.workspaces === 1 ? "" : "s"} · {summary.runningChats.length ? `running: ${summary.runningChats.map((c) => c.title).join(", ")}` : "nothing running"}
      </p>
      {summary.pending.map((p) => (
        <div key={p.id} className="flex items-center gap-2 rounded-md bg-zinc-900 px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-zinc-200">
              {p.chatTitle}: {p.title}
            </p>
            {p.detail && <p className="truncate font-mono text-[11px] text-zinc-500">{p.detail}</p>}
          </div>
          {p.kind === "question" ? (
            <span className="text-zinc-500">Answer on the machine</span>
          ) : (
            <>
              <Button
                className="py-0.5! text-xs"
                variant="primary"
                disabled={action.busy}
                onClick={() => void action.run(async () => (await api.answerOnMachine(machine.id, p.id, p.kind === "plan" ? { kind: "plan", action: "approve" } : { kind: "tool", allow: true }), await load()))}
              >
                Approve
              </Button>
              {p.kind === "tool" && (
                <Button className="py-0.5! text-xs" disabled={action.busy} onClick={() => void action.run(async () => (await api.answerOnMachine(machine.id, p.id, { kind: "tool", allow: false }), await load()))}>
                  Deny
                </Button>
              )}
            </>
          )}
        </div>
      ))}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

/** Computers this Cadence can open from anywhere, and this machine's own link to a hub. */
export function MachinesSettings({ snapshot }: { snapshot: Snapshot }) {
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [link, setLink] = useState<MachineLinkStatus | null>(null);
  const [hub, setHub] = useState({ hubUrl: "", token: "" });
  const action = useAction();
  const linkAction = useAction();
  const owner = snapshot.viewer.role === "owner";

  const load = () => api.machines().then(setMachines, (e: Error) => action.setError(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    if (owner) api.machineLink().then(setLink, () => undefined);
    const l = owner ? setInterval(() => api.machineLink().then(setLink, () => undefined), 4000) : null;
    return () => {
      clearInterval(t);
      if (l) clearInterval(l);
    };
  }, []);

  const command = created ? `CADENCE_HUB_URL=${window.location.origin} CADENCE_MACHINE_TOKEN=${created.token} npm start` : "";
  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-3">
        <p className="text-sm text-zinc-400">
          Connect another computer running Cadence, then open it from here: its workspaces, agents, canvases, and terminals, from any browser that can reach this Cadence. The machine dials out, so it needs no open ports. Owners and admins here get full control
          of it.
        </p>
        <div className="flex gap-2">
          <input className={inputClass} placeholder="Studio desktop" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            variant="primary"
            disabled={!name.trim() || action.busy}
            onClick={() =>
              void action.run(async () => {
                const r = await api.addMachine(name.trim());
                setCreated({ name: r.machine.name, token: r.token });
                setName("");
                await load();
              })
            }
          >
            Add machine
          </Button>
        </div>
        {created && (
          <div className="space-y-2 rounded-lg bg-zinc-900 p-3 text-xs ring-1 ring-violet-800">
            <p className="text-zinc-300">
              Token for <span className="font-medium">{created.name}</span>. It is shown once. On that machine, paste it into Settings &gt; Computers &gt; This computer, or start Cadence with:
            </p>
            <pre className="overflow-x-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">{command}</pre>
            <div className="flex gap-2">
              <Button className="py-1! text-xs" onClick={() => void navigator.clipboard.writeText(created.token)}>
                Copy token
              </Button>
              <Button className="py-1! text-xs" variant="ghost" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
        <div className="space-y-2">
          {machines?.length === 0 && <p className="text-sm text-zinc-500">No machines yet.</p>}
          {machines?.map((m) => (
            <div key={m.id} className="space-y-2 rounded-lg p-3 ring-1 ring-zinc-800">
              <div className="flex items-center gap-3">
                <span className={`size-2 shrink-0 rounded-full ${m.online ? "bg-emerald-500" : "bg-zinc-600"}`} title={m.online ? "Connected" : "Offline"} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{m.name}</p>
                  <p className="text-xs text-zinc-500">
                    {m.hostname ? `${m.hostname} · ${m.platform} · Cadence ${m.version}` : "Never connected"}
                    {!m.online && m.lastSeenAt ? ` · seen ${timeAgo(m.lastSeenAt)}` : ""}
                  </p>
                </div>
                <Button className="py-1! text-xs" variant="primary" disabled={!m.online || action.busy} onClick={() => void action.run(async () => window.open((await api.openMachine(m.id)).url, "_blank", "noopener"))}>
                  Open
                </Button>
                <Button
                  className="py-1! text-xs"
                  variant="ghost"
                  onClick={() => {
                    const name = prompt("Rename machine", m.name);
                    if (name && name.trim() !== m.name) void action.run(async () => (await api.renameMachine(m.id, name.trim()), await load()));
                  }}
                >
                  Rename
                </Button>
                <Button className="py-1! text-xs" variant="ghost" disabled={action.busy} onClick={() => confirm(`Remove ${m.name}? Its token stops working and it disconnects.`) && void action.run(async () => (await api.removeMachine(m.id), await load()))}>
                  Remove
                </Button>
              </div>
              {m.online && <MachineActivity machine={m} />}
            </div>
          ))}
        </div>
        <ErrorText>{action.error}</ErrorText>
      </section>

      {owner && link && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">This computer</h2>
          <p className="text-sm text-zinc-400">Let another Cadence (a hub) open this one. Make a token on the hub under Settings &gt; Computers.</p>
          {link.hubUrl ? (
            <div className="flex items-center gap-3 rounded-lg p-3 text-sm ring-1 ring-zinc-800">
              <span className={`size-2 rounded-full ${link.state === "connected" ? "bg-emerald-500" : link.state === "error" ? "bg-red-500" : "bg-amber-400"}`} />
              <div className="min-w-0 flex-1">
                <p>
                  {link.state === "connected" ? `Connected to ${link.hubUrl}` : link.state === "error" ? `Not connected to ${link.hubUrl}` : `Connecting to ${link.hubUrl}...`}
                  {link.machineName && <span className="text-zinc-500"> as {link.machineName}</span>}
                </p>
                {link.error && <p className="text-xs text-red-400">{link.error}</p>}
              </div>
              <Button className="py-1! text-xs" disabled={linkAction.busy} onClick={() => void linkAction.run(async () => setLink(await api.disconnectMachineLink()))}>
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Field label="Hub address">
                <input className={inputClass} placeholder="https://cadence.example.com" value={hub.hubUrl} onChange={(e) => setHub({ ...hub, hubUrl: e.target.value })} />
              </Field>
              <Field label="Token">
                <input className={`${inputClass} font-mono`} placeholder="cdm..." value={hub.token} onChange={(e) => setHub({ ...hub, token: e.target.value })} />
              </Field>
              <div className="flex items-end">
                <Button variant="primary" disabled={!hub.hubUrl.trim() || !hub.token.trim() || linkAction.busy} onClick={() => void linkAction.run(async () => setLink(await api.connectMachineLink(hub)))}>
                  Connect
                </Button>
              </div>
            </div>
          )}
          <ErrorText>{linkAction.error}</ErrorText>
        </section>
      )}
    </div>
  );
}
