import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/pnpm-lock.yaml",
      ".data/**",
      // Spaces templates are the agent's starting point inside its computer, not backend code (browser and Bun globals, own tsconfig).
      "packages/sandbox-image/files/skills/*/templates/**",
      "**/.data/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
  },
  {
    files: ["**/*.ts"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Keep the pinned upstream file byte-for-byte; verify its integrity separately.
    files: ["packages/juno-agent/third-party/jev-browser/page-model.mjs"],
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
);
