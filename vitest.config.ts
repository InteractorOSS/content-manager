import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Default env stays node — the .tsx component tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock.
    environment: "node",
    // scripts/ is included too: scripts/diagnose-sso.mjs has to stay
    // dependency-free plain ESM (an operator copies it to the production box on
    // its own), so its verdict helpers are tested next to it rather than in src/.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.mjs",
    ],
  },
});
