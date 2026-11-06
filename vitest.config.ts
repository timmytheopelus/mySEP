import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)), "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**", "node_modules/**"] },
});
