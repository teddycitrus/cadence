import { claudeAccount } from "./claude-binary";
import type { ProviderRegistry } from "./providers";

const PLAN: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

/**
 * How agents here reach a model, for the setup check: a key saved in Settings > Providers or
 * set in the environment, or Claude Code's own sign-in. Null when there is none yet.
 */
export async function modelAccess(providers: ProviderRegistry): Promise<string | null> {
  for (const p of providers.all()) {
    const saved = p.keyEnvs.find((k) => p.envSet.includes(k));
    if (saved) return `${p.label}: ${saved} saved`;
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "Claude Code: Anthropic key in the environment";
  const account = await claudeAccount();
  if (!account?.loggedIn) return null;
  if (account.method !== "claude.ai") return `Claude Code: ${account.method ?? "signed in"}`;
  return `Claude ${PLAN[account.plan ?? ""] ?? "account"}${account.email ? `, ${account.email}` : ""}`;
}
