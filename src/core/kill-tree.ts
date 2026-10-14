import { spawn, type ChildProcess } from "node:child_process";

/**
 * Ends a child process and anything it started, resolving once it has exited (or after a few
 * seconds). On Windows that is taskkill /T; elsewhere a SIGTERM. Neither blocks the server.
 */
export function killTree(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return Promise.resolve();
  const exited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => (clearTimeout(timer), resolve()));
  });
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => proc.kill());
  else proc.kill("SIGTERM");
  return exited;
}
