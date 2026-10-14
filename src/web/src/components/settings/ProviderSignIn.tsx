import { lazy, Suspense, useEffect, useState } from "react";
import type { ProviderId } from "../../../../core/providers";
import { api, type ClaudeAccount, type TerminalInfo } from "../../api";
import { Button, ErrorText, useAction } from "../ui";

// The terminal (xterm) loads only when someone signs in.
const TerminalView = lazy(() => import("../terminal/TerminalPanel").then((m) => ({ default: m.TerminalView })));

const PLAN: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

/** Who Claude Code is signed in as, read from the harness itself. */
function ClaudeAccountLine({ refresh }: { refresh: number }) {
  const [account, setAccount] = useState<ClaudeAccount | null | undefined>(undefined);
  useEffect(() => {
    setAccount(undefined);
    void api.providerAccount("claude-code").then((r) => setAccount(r.account), () => setAccount(null));
  }, [refresh]);
  if (account === undefined) return <p className="text-sm text-zinc-500">Checking the sign-in...</p>;
  if (!account) return <p className="text-sm text-zinc-500">Could not read Claude Code's sign-in.</p>;
  if (!account.loggedIn) return <p className="text-sm text-amber-300">Not signed in. Sign in with your Claude account, or add an Anthropic API key below.</p>;
  const via = account.method === "claude.ai" ? `Claude ${PLAN[account.plan ?? ""] ?? "subscription"}` : (account.method ?? "API key");
  return (
    <p className="text-sm text-emerald-400">
      Signed in{account.email ? ` as ${account.email}` : ""} ({via}).
    </p>
  );
}

/**
 * Signing in with the harness's own account (a Claude or ChatGPT subscription, a Cursor or xAI
 * login): its sign-in runs in a terminal right here, and links it opens go to the browser.
 */
export function ProviderSignIn({ provider, onDone }: { provider: ProviderId; onDone: () => void }) {
  const [term, setTerm] = useState<TerminalInfo | null>(null);
  const [refresh, setRefresh] = useState(0);
  const action = useAction();
  const close = () => {
    if (term) void api.closeTerminal(term.id).catch(() => undefined);
    setTerm(null);
    setRefresh((n) => n + 1);
    onDone();
  };
  useEffect(() => () => void (term && api.closeTerminal(term.id).catch(() => undefined)), [term]);
  return (
    <div className="space-y-2">
      {provider === "claude-code" && <ClaudeAccountLine refresh={refresh} />}
      {!term ? (
        <Button disabled={action.busy} onClick={() => action.run(async () => setTerm(await api.providerSignIn(provider)))}>
          Sign in with your account
        </Button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">Follow the steps below. When it opens a link, finish signing in in your browser, then come back here.</p>
          <div className="h-72 overflow-hidden rounded-lg ring-1 ring-zinc-800">
            <Suspense fallback={<p className="p-3 text-sm text-zinc-500">Opening a terminal...</p>}>
              <TerminalView term={term} visible />
            </Suspense>
          </div>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}
