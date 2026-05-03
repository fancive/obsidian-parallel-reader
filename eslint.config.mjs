import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["main.ts", "src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // Out-of-scope for an Obsidian plugin lint pass: TS-strict noise
      // from JSON.parse / dynamic i18n keys. Biome + tsc cover type safety.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // streaming.ts legitimately uses bare `fetch` because Obsidian's `requestUrl`
    // does not support streaming responses (it's a one-shot wrapper).
    files: ["src/streaming.ts"],
    rules: {
      "no-restricted-globals": "off",
    },
  },
  {
    ignores: [
      "node_modules/",
      "main.js",
      "main.js.map",
      "tests/",
      "scripts/",
      ".e2e/",
      ".orchestration/",
      ".agent/",
      ".codex-tmp/",
    ],
  },
]);
