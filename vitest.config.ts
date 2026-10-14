import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["references/**", "test/**/*.integration.test.ts"],
    restoreMocks: true,
  },
});
