import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Type-level tests (`*.test-d.ts`) are checked by tsc, not executed.
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test-d.ts"],
      tsconfig: "tests/tsconfig.json",
    },
  },
});
