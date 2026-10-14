import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // Many files start real servers, Chrome, and harness processes; fewer at once keeps them from starving each other.
    maxWorkers: 4,
    // Tests never reach the real GitHub with the developer's own credentials.
    env: { GITHUB_TOKEN: "", GH_TOKEN: "", CADENCE_DISABLE_GH_CLI: "1" },
  },
});
