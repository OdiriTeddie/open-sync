import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@open-sync/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["./test/browser/**/*.test.ts"],
    isolate: true,
    browser: {
      enabled: true,
      headless: true,
      name: "chromium",
      provider: "playwright"
    }
  }
});