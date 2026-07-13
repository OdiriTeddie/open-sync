import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@open-sync/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url))
    }
  },
  test: {
    setupFiles: ["./test/setup.ts"],
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "./test/browser/**"],
    isolate: true
  }
});