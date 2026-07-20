import { defineConfig } from "vitest/config";

// The core logic is framework-agnostic and runs in a plain Node environment,
// so unit tests need no DOM. This keeps the test run fast and dependency-free.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
