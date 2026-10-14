import { useEffect, useState } from "react";
import { api } from "../../api";
import { Button, ErrorText, Field, inputClass, useAction } from "../ui";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid h-dvh place-items-center bg-zinc-950 p-6">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-violet-500 text-zinc-950">
            <svg viewBox="0 0 32 32" className="size-5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 20l5-8 4 6 5-8" />
            </svg>
          </div>
          <span className="font-semibold">Cadence</span>
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** Email and password sign-in, with a way to ask for access. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"signin" | "request" | "requested">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const action = useAction();

  if (mode === "requested") {
    return (
      <Shell title="Request sent">
        <p className="text-sm text-zinc-400">An admin will send you an invite link if they approve.</p>
        <button className="text-sm text-violet-300 hover:underline" onClick={() => setMode("signin")}>
          Back to sign in
        </button>
      </Shell>
    );
  }
  if (mode === "request") {
    return (
      <Shell title="Request access">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Email">
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Why you need access (optional)">
          <textarea className={`${inputClass} min-h-16`} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <Button variant="primary" className="w-full" disabled={!name.trim() || !email.trim() || action.busy} onClick={() => action.run(async () => (await api.requestAccess({ name, email, message }), setMode("requested")))}>
          Send request
        </Button>
        <ErrorText>{action.error}</ErrorText>
        <button className="text-sm text-zinc-400 hover:text-zinc-100" onClick={() => setMode("signin")}>
          I have an account
        </button>
      </Shell>
    );
  }
  return (
    <Shell title="Sign in">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api.login(email, password);
            onDone();
          });
        }}
      >
        <Field label="Email">
          <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" disabled={!email || !password || action.busy}>
          {action.busy ? "Signing in..." : "Sign in"}
        </Button>
        <ErrorText>{action.error}</ErrorText>
      </form>
      <p className="text-sm text-zinc-500">
        New here? Ask a teammate for an invite link, or{" "}
        <button className="text-violet-300 hover:underline" onClick={() => setMode("request")}>
          request access
        </button>
        .
      </p>
    </Shell>
  );
}

/** Joining through an invite link: pick a name, email, and password. */
export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ valid: boolean; role?: string } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction();
  useEffect(() => {
    api.peekInvite(token).then(setInfo, () => setInfo({ valid: false }));
  }, [token]);

  if (!info) return <Shell title="Checking your invite...">{null}</Shell>;
  if (!info.valid) {
    return (
      <Shell title="This invite has expired">
        <p className="text-sm text-zinc-400">Invite links work once and expire after a week. Ask whoever invited you for a new one.</p>
        <a className="text-sm text-violet-300 hover:underline" href="#/">
          Go to sign in
        </a>
      </Shell>
    );
  }
  return (
    <Shell title={`Join as ${info.role === "admin" ? "an admin" : "a member"}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api.acceptInvite(token, { name, email, password });
            window.location.hash = "/issues";
            onDone();
          });
        }}
      >
        <Field label="Your name">
          <input className={inputClass} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Email">
          <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <input className={inputClass} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" disabled={!name.trim() || !email.trim() || password.length < 10 || action.busy}>
          Join
        </Button>
        <ErrorText>{action.error}</ErrorText>
      </form>
    </Shell>
  );
}
