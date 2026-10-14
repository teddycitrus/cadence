import { useEffect, useRef, useState } from "react";
import { api, type OrgInfo } from "../api";
import { switchOrg } from "../org";
import { Button, ErrorText, inputClass, useAction } from "./ui";
import { CadenceMark } from "./Logo";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** The logo button: which organization this is, switching between them, and making a new one. */
export function OrgSwitcher() {
  const [orgs, setOrgs] = useState<OrgInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const action = useAction();
  const box = useRef<HTMLDivElement>(null);
  const reload = () => void api.orgs().then(setOrgs, () => undefined);
  useEffect(reload, []);
  // With several orgs, check now and then for activity elsewhere.
  useEffect(() => {
    if (orgs.length < 2) return;
    const t = window.setInterval(reload, 30_000);
    return () => window.clearInterval(t);
  }, [orgs.length]);
  const elsewhere = orgs.filter((o) => !o.current);
  const busyElsewhere = elsewhere.some((o) => (o.running ?? 0) > 0);
  const unreadElsewhere = elsewhere.some((o) => (o.unread ?? 0) > 0);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const current = orgs.find((o) => o.current);
  // Only this Cadence's owner (owner of the first org) can make organizations.
  const canCreate = orgs.some((o) => o.id === "default" && o.role === "owner");

  return (
    <div ref={box} className="relative mb-3">
      {(busyElsewhere || unreadElsewhere) && <span className={`absolute -top-0.5 -right-0.5 z-10 size-2 rounded-full ring-2 ring-zinc-950 ${busyElsewhere ? "animate-pulse bg-violet-400" : "bg-sky-400"}`} title="Activity in another organization" />}
      <button
        onClick={() => (setOpen(!open), reload())}
        className={`grid size-8 place-items-center rounded-lg text-[11px] font-semibold ${current?.logo || (current && orgs.length > 1) ? "bg-violet-400 text-zinc-900" : "text-zinc-100 hover:bg-zinc-800/60"}`}
        title={current ? `${current.name} (switch organization)` : "Cadence"}
      >
        {current?.logo ? (
          <img src={current.logo} alt="" className="size-8 rounded-lg object-cover" />
        ) : current && orgs.length > 1 ? (
          initials(current.name)
        ) : (
          <CadenceMark size={30} />
        )}
      </button>
      {open && (
        <div className="absolute top-0 left-10 z-50 w-72 space-y-1 rounded-lg bg-zinc-900 p-2 shadow-2xl ring-1 ring-zinc-700">
          <p className="px-2 pt-1 pb-1 text-[11px] tracking-wide text-zinc-500 uppercase">Organizations</p>
          {orgs.map((o) => (
            <button key={o.id} onClick={() => (o.current ? setOpen(false) : switchOrg(o.id))} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${o.current ? "bg-zinc-800" : "hover:bg-zinc-800/60"}`}>
              {o.logo ? <img src={o.logo} alt="" className="size-6 shrink-0 rounded object-cover" /> : <span className="grid size-6 shrink-0 place-items-center rounded bg-violet-400 text-[10px] font-semibold text-zinc-900">{initials(o.name)}</span>}
              <span className="min-w-0 flex-1 truncate">{o.name}</span>
              {!o.current && (o.running ?? 0) > 0 && <span className="size-1.5 animate-pulse rounded-full bg-violet-400" title={`${o.running} running`} />}
              {!o.current && (o.unread ?? 0) > 0 && <span className="size-1.5 rounded-full bg-sky-400" title={`${o.unread} unread`} />}
              <span className="text-[11px] text-zinc-500">{o.role}</span>
              {o.current && <span className="text-violet-300">✓</span>}
            </button>
          ))}
          {canCreate &&
            (creating ? (
              <form
                className="space-y-2 border-t border-zinc-800 px-1 pt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action.run(async () => {
                    const org = await api.createOrg({ name });
                    switchOrg(org.id);
                  });
                }}
              >
                <input autoFocus className={inputClass} placeholder="Organization name" value={name} onChange={(e) => setName(e.target.value)} />
                <p className="text-xs text-zinc-500">It gets its own members, projects, agents, docs, and integrations. Nothing is shared with the others.</p>
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" disabled={!name.trim() || action.busy}>
                    Create
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                </div>
                <ErrorText>{action.error}</ErrorText>
              </form>
            ) : (
              <button onClick={() => setCreating(true)} className="w-full rounded-md px-2 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100">
                + New organization
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
