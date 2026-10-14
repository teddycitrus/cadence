// Where the desktop app's window points: the Cadence server it runs itself, or
// a team's server it joined. Kept free of Electron so it can be tested.

/** A team server address someone typed or pasted (an invite link works too): its origin, and the page to open there. */
export function parseServerAddress(raw: string): { origin: string; hash: string } {
  const text = raw.trim();
  if (!text) throw new Error("Enter your team server's address");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("That does not look like a web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("A team server's address starts with https://");
  // Passwords cross the internet only encrypted; plain http is for this computer and the local network.
  if (url.protocol === "http:" && !isLocalNetwork(url.hostname)) throw new Error("Use the server's https:// address; plain http would send your password unencrypted");
  if (url.username || url.password) throw new Error("Leave the user name and password out of the address");
  return { origin: url.origin, hash: url.hash.startsWith("#/") ? url.hash : "" };
}

export function isLocalNetwork(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Whether a URL is on exactly this origin (startsWith would let https://team.example.com.evil.test through). */
export function onOrigin(url: string, origin: string): boolean {
  try {
    return Boolean(origin) && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Whether a Cadence answers at this origin (its sign-in check answers anyone). */
export async function isCadence(origin: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<boolean> {
  try {
    const res = await fetchImpl(`${origin}/api/auth/me`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body.signedIn === "boolean" && typeof body.team === "boolean";
  } catch {
    return false;
  }
}
