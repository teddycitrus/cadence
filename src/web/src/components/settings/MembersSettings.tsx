import { useEffect, useState } from "react";
import { orgParam } from "../../org";
import type { Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { Button, ErrorText, Field, inputClass, timeAgo, useAction, UserAvatar } from "../ui";

const inviteUrl = (token: string) => `${window.location.origin}/#/invite/${token}${orgParam()}`;

function Profile({ snapshot }: { snapshot: Snapshot }) {
  const me = snapshot.members.find((m) => m.id === snapshot.viewer.memberId);
  const [name, setName] = useState(me?.name ?? "");
  const [email, setEmail] = useState(me?.email ?? "");
  const [password, setPassword] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const action = useAction();
  if (!me) return null;
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Your profile</h2>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" hint={me.role === "owner" ? "Needed to sign in from another machine." : undefined}>
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <Button disabled={action.busy || (name === me.name && email === me.email)} onClick={() => action.run(async () => (await api.updateMember(me.id, { name, email }), setSaved("Profile saved.")))}>
        Save profile
      </Button>
      <Field label={me.role === "owner" ? "Password for signing in from other machines" : "New password"} hint="At least 10 characters.">
        <div className="flex gap-2">
          <input className={inputClass} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button
            disabled={password.length < 10 || action.busy}
            onClick={() =>
              action.run(async () => {
                await api.setPassword(password);
                setPassword("");
                setSaved("Password set.");
              })
            }
          >
            Set password
          </Button>
        </div>
      </Field>
      {saved && <p className="text-sm text-emerald-400">{saved}</p>}
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}

function Team({ snapshot }: { snapshot: Snapshot }) {
  const admin = snapshot.viewer.role !== "member";
  const [invites, setInvites] = useState<Awaited<ReturnType<typeof api.invites>>>([]);
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof api.accessRequests>>>([]);
  const [link, setLink] = useState<string | null>(null);
  const [role, setRole] = useState<"member" | "admin">("member");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const action = useAction();
  const reload = () => {
    if (!admin) return;
    api.invites().then(setInvites, () => undefined);
    api.accessRequests().then(setRequests, () => undefined);
  };
  useEffect(reload, [admin]);

  return (
    <section className="space-y-3">
      <h2 className="font-medium">Members</h2>
      <ul className="divide-y divide-zinc-900 rounded-lg ring-1 ring-zinc-800">
        {snapshot.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <UserAvatar member={m} size="size-6" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {m.name}
                {m.id === snapshot.viewer.memberId && <span className="text-zinc-500"> (you)</span>}
              </span>
              <span className="block truncate text-xs text-zinc-500">{m.email || "no email"}</span>
            </span>
            {m.role === "owner" || !admin ? (
              <span className="text-xs text-zinc-400 capitalize">{m.role}</span>
            ) : (
              <select className={`${inputClass} w-auto py-1! text-xs`} value={m.role} onChange={(e) => action.run(() => api.updateMember(m.id, { role: e.target.value as "admin" | "member" }))}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            )}
            {admin && m.role !== "owner" && (
              <button className="text-xs text-zinc-500 hover:text-red-400" onClick={() => confirm(`Remove ${m.name}? They are signed out at once.`) && action.run(() => api.removeMember(m.id))}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-zinc-500">Members work the board, docs, and comments. Admins can also run chats, terminals, and git, which execute on this machine with its credentials.</p>
      {admin && (
        <>
          <div className="flex items-center gap-2">
            <select className={`${inputClass} w-auto`} value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <input className={inputClass} type="email" placeholder="Email (optional: sends the invite)" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button
              variant="primary"
              onClick={() =>
                action.run(async () => {
                  const r = await api.createInvite(role, email.trim() || undefined);
                  setLink(inviteUrl(r.token));
                  setSent(r.emailed ? email.trim() : null);
                  setEmail("");
                  reload();
                })
              }
            >
              {email.trim() ? "Send invite" : "Create invite link"}
            </Button>
          </div>
          {sent && <p className="text-xs text-emerald-400">Invite emailed to {sent}.</p>}
          {link && (
            <div className="space-y-1 rounded-lg bg-emerald-950/40 p-3 text-xs ring-1 ring-emerald-900">
              <p className="text-emerald-300">Send this link to one person. It works once, for 7 days, and is not shown again.</p>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 truncate text-zinc-200">{link}</code>
                <button className="text-zinc-300 hover:text-zinc-50" onClick={() => void navigator.clipboard.writeText(link)}>
                  Copy
                </button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <div className="space-y-1 text-sm">
              <p className="text-zinc-400">Pending invites</p>
              {invites.map((i) => (
                <div key={i.id} className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="capitalize">{i.role}</span>
                  {i.email && <span className="text-zinc-300">{i.email}</span>}
                  <span>expires in {Math.max(1, Math.round((Date.parse(i.expiresAt) - Date.now()) / 86_400_000))} days</span>
                  <button className="ml-auto hover:text-red-400" onClick={() => action.run(async () => (await api.revokeInvite(i.id), reload()))}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
          {requests.length > 0 && (
            <div className="space-y-2 text-sm">
              <p className="text-zinc-400">Access requests</p>
              {requests.map((r) => (
                <div key={r.id} className="flex items-start gap-3 rounded-lg bg-zinc-900 p-2 ring-1 ring-zinc-800">
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      {r.name} <span className="text-zinc-500">{r.email}</span>
                    </span>
                    {r.message && <span className="block text-xs text-zinc-400">{r.message}</span>}
                  </span>
                  <Button
                    className="py-1! text-xs"
                    onClick={() =>
                      action.run(async () => {
                        const approved = await api.approveRequest(r.id, "member");
                        setLink(inviteUrl(approved.token));
                        setSent(approved.emailed ? r.email : null);
                        reload();
                      })
                    }
                  >
                    Approve
                  </Button>
                  <button className="text-xs text-zinc-500 hover:text-red-400" onClick={() => action.run(async () => (await api.denyRequest(r.id), reload()))}>
                    Deny
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}

/** The SMTP server invites are sent through (per organization). */
export function EmailSettings() {
  const [status, setStatus] = useState<{ configured: boolean; host: string | null; from: string | null } | null>(null);
  const [form, setForm] = useState({ host: "", port: "587", secure: false, user: "", pass: "", from: "" });
  const action = useAction();
  useEffect(() => {
    api.emailSettings().then((s) => {
      setStatus(s);
      if (s.host) setForm((f) => ({ ...f, host: s.host!, from: s.from ?? "" }));
    }, () => undefined);
  }, []);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Email</h2>
      <p className="text-sm text-zinc-500">{status?.configured ? `Invites are sent from ${status.from} through ${status.host}.` : "Add an SMTP server to send invites by email. Without one, share invite links yourself."}</p>
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <Field label="SMTP host">
          <input className={inputClass} placeholder="smtp.example.com" value={form.host} onChange={(e) => set({ host: e.target.value })} />
        </Field>
        <Field label="Port">
          <input className={inputClass} value={form.port} onChange={(e) => set({ port: e.target.value, secure: e.target.value === "465" })} />
        </Field>
        <Field label="Username">
          <input className={inputClass} autoComplete="off" value={form.user} onChange={(e) => set({ user: e.target.value })} />
        </Field>
        <Field label="TLS">
          <select className={inputClass} value={form.secure ? "tls" : "starttls"} onChange={(e) => set({ secure: e.target.value === "tls" })}>
            <option value="starttls">STARTTLS</option>
            <option value="tls">TLS</option>
          </select>
        </Field>
        <Field label="Password" hint={status?.configured ? "Leave empty to keep the saved one." : undefined}>
          <input className={inputClass} type="password" autoComplete="new-password" value={form.pass} onChange={(e) => set({ pass: e.target.value })} />
        </Field>
        <span />
        <Field label="From">
          <input className={inputClass} placeholder="Cadence <cadence@example.com>" value={form.from} onChange={(e) => set({ from: e.target.value })} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!form.host || !form.from || action.busy}
          onClick={() => action.run(async () => setStatus(await api.saveEmailSettings({ host: form.host.trim(), port: Number(form.port) || 587, secure: form.secure, user: form.user, pass: form.pass, from: form.from.trim() })))}
        >
          {action.busy ? "Checking..." : "Save and test"}
        </Button>
        {status?.configured && (
          <Button variant="ghost" onClick={() => action.run(async () => setStatus(await api.saveEmailSettings(null)))}>
            Remove
          </Button>
        )}
      </div>
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}

/** Your profile, the team, invites, and access requests. */
export function MembersSettings({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="max-w-2xl space-y-8">
      <Profile snapshot={snapshot} />
      <Team snapshot={snapshot} />
      {snapshot.viewer.role !== "member" && <EmailSettings />}
    </div>
  );
}
