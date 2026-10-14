// The organization this tab works in. Requests name it in a header, and a
// cookie covers what cannot send headers (images, the event stream, sockets).

export const DEFAULT_ORG = "default";
const KEY = "cadence.org";

function read(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT_ORG;
  } catch {
    return DEFAULT_ORG;
  }
}

let current = read();

function remember(id: string): void {
  current = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable: this tab still uses it
  }
  document.cookie = `cadence_org=${encodeURIComponent(id)}; Path=/; SameSite=Lax; Max-Age=31536000`;
}

export const currentOrg = () => current;

/** Switches organization: everything reloads in the new one. */
export function switchOrg(id: string): void {
  remember(id);
  window.location.hash = "#/home";
  window.location.reload();
}

/** "?org=..." (or "&org=...") for links that leave this tab: invites, shares, webhooks, MCP. */
export const orgParam = (sep: "?" | "&" = "?") => (current === DEFAULT_ORG ? "" : `${sep}org=${encodeURIComponent(current)}`);

/**
 * Links into an org carry ?org= in the hash (#/invite/abc?org=...) or in the
 * query string (/?org=...). Adopt it, then drop it from the address so routes
 * stay plain.
 */
export function adoptOrgFromUrl(): void {
  const param = /[?&]org=([\w-]{1,100})/;
  const m = param.exec(window.location.hash) ?? param.exec(window.location.search);
  if (!m) return remember(current);
  remember(m[1]!);
  const search = window.location.search.replace(param, (_x, _id, offset: number) => (offset === 0 ? "?" : "")).replace(/^\?&?$/, "").replace(/^\?&/, "?");
  history.replaceState(null, "", window.location.pathname + search + window.location.hash.replace(param, ""));
}
