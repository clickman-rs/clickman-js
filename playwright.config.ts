import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3107" },
  webServer: {
    command: "pnpm build && node tests/browser/server.mjs",
    port: 3107,
    reuseExistingServer: false,
  },
});
