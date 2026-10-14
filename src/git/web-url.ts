// Shared by the server and the web client; no Node imports.

/** The web page for a git remote (GitHub, GitLab, Bitbucket, or any https remote), or null for local paths. */
export function webUrl(remote: string): string | null {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const http = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote);
  return http ? `https://${http[1]}/${http[2]}` : null;
}
