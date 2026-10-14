import { describe, expect, it } from "vitest";
import { commandHint, hintsOf } from "../src/agents/command-hints";

describe("slash command hints", () => {
  it("keeps the first line, shortens long ones, and appends the argument hint", () => {
    expect(commandHint("Clear the conversation\nand start fresh")).toBe("Clear the conversation");
    expect(commandHint("Review a pull request", "<pr>")).toBe("Review a pull request <pr>");
    expect(commandHint("x".repeat(200))).toHaveLength(120);
  });

  it("maps listed names, aliases included, and skips commands without a description", () => {
    const cmds = [
      { name: "usage", description: "Show plan usage", argumentHint: "", aliases: ["cost"] },
      { name: "secret", description: "" },
      { name: "hidden", description: "Not listed" },
    ];
    expect(hintsOf(cmds, ["usage", "cost", "secret"])).toEqual({ usage: "Show plan usage", cost: "Show plan usage" });
  });
});
