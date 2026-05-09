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
      // Keep this review check close to Obsidian policy rules while avoiding
      // project-specific dynamic-type noise that the ReviewBot did not report.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // The ReviewBot currently reports underscore-only unused bindings as
      // Optional findings, while the published recommended config ignores them.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          caughtErrors: "all",
          ignoreRestSiblings: true,
        },
      ],
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
