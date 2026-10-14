import { describe, expect, it } from "vitest";
import { openFolderIn, openTargets } from "../src/workspaces/open-in";

describe("opening a workspace in another app", () => {
  it("always offers the file manager, plus only editors found on PATH", () => {
    const targets = openTargets();
    expect(targets[0]).toEqual({ id: "files", label: process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "File Explorer" : "Files" });
    const known = ["vscode", "cursor", "windsurf", "zed", "sublime", "webstorm", "idea"];
    for (const t of targets.slice(1)) expect(known).toContain(t.id);
  });

  it("refuses apps that are not in its list", () => {
    expect(() => openFolderIn(process.cwd(), "notepad")).toThrow(/not installed/);
  });
});
