import { defineConfig } from "vitest/config";
import path from "path";

// Vitest config for the FinCore deterministic logic engine (src/lib/fincore/*).
// Kept separate from vite.config.ts so the app's dev/build pipeline is untouched.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
