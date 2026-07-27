import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // The backend (Node stdlib, node:test runner) lives under
    // backend/; vitest would otherwise try to load them and fail with
    // "No test suite found".  Run them separately with `npm run
    // test:backend` (or `npm run test:all`).
    exclude: ["backend/**", "node_modules/**"],
    restoreMocks: true,
  },
});
