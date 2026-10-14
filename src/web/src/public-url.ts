import { api } from "./api";

// The address to put in links people send each other (invites, share links,
// webhook and MCP URLs): Cadence's public address when it has one (a team
// server, or this computer shared through a tunnel), else the one this page
// is open on.

let publicOrigin: string | null = null;

export function linkOrigin(): string {
  return publicOrigin ?? window.location.origin;
}

/** Reads the public address again (on start, and after sharing turns on or off). */
export async function refreshLinkOrigin(): Promise<string> {
  try {
    const s = await api.sharing();
    publicOrigin = s.publicUrl ? new URL(s.publicUrl).origin : null;
  } catch {
    publicOrigin = null;
  }
  return linkOrigin();
}

/** Sets it from a status the caller already has. */
export function setLinkOrigin(publicUrl: string | null): void {
  publicOrigin = publicUrl ? new URL(publicUrl).origin : null;
}
