import { rmSync } from "node:fs";

/**
 * Deletes a test's temp folder. On Windows a child process that just exited
 * (git, a shell, a harness) can hold it open for a moment, so this retries,
 * and leaves it to the OS temp cleanup rather than failing the test.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw err;
  }
}
