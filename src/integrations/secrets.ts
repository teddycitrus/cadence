import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Integration credentials, kept in one file in the data dir (owner-only
 * permissions) and never in the event log, so they are not replayed, exported,
 * or sent to the browser.
 */
export class SecretStore {
  constructor(
    private dataDir: string,
    /** A second instance with another file holds plain integration settings. */
    private fileName = "secrets.json",
  ) {}

  private file(): string {
    return join(this.dataDir, this.fileName);
  }

  private read(): Record<string, string> {
    try {
      return existsSync(this.file()) ? (JSON.parse(readFileSync(this.file(), "utf8")) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  get(key: string): string | null {
    return this.read()[key] ?? null;
  }

  has(key: string): boolean {
    return Boolean(this.get(key));
  }

  set(key: string, value: string | null): void {
    const all = this.read();
    if (value) all[key] = value;
    else delete all[key];
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file());
  }
}
