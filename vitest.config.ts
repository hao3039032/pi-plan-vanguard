import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    },
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/vitest.global-setup.ts"],
    // Integration files spawn Git, LSP, and MCP children in addition to their workers.
    // Two fork workers leave room for cold Jiti loads and their child processes
    // without enlarging the five-second per-test budget. CLI overrides remain available.
    maxWorkers: Math.min(2, availableParallelism()),
    pool: "forks",
    runner: "./test/vitest.runner.ts",
    setupFiles: ["./test/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
