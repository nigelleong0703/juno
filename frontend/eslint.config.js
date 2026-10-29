import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";

const APP_NODE_PATH_NAMES = [
  "electron",
  "fs",
  "fs/promises",
  "path",
  "os",
  "child_process",
  "crypto",
  "http",
  "https",
  "net",
  "url",
  "stream",
  "events",
  "buffer",
  "util",
  "worker_threads",
];

const APP_NODE_RUNTIME_MESSAGE =
  "packages/app must not import Electron/Node builtins; inject a PlatformAdapter (ARCHITECTURE \u00a73, \u00a79).";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/release/**",
      "**/vendor/**",
      "**/build/**",
      "**/storybook-static/**",
      "**/screenshots/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/pnpm-lock.yaml",
      // Vendored third-party bundle (noVNC for the iPhone screen viewer), not our source.
      "packages/ios/**/*.js",
      // The same noVNC bundle, shipped as an Android asset.
      "packages/android/**/assets/**",
      // Scratch fixtures written and deleted by verify scripts (QA2-http-types writes
      // packages/client/.data/qa2-http-types.ts) are never lintable source: scanning them
      // races the deletion and fails lint with ENOENT.
      ".data/**",
      "**/.data/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS tooling (e.g. packages/ui/scripts/*.mjs) runs in Node; browser
    // globals appear in Playwright page callbacks serialized to the page.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "ui", pattern: "packages/ui/src/**" },
        { type: "client", pattern: "packages/client/src/**" },
        { type: "app", pattern: "packages/app/src/**" },
        { type: "desktop", pattern: "packages/desktop/**" },
        { type: "web", pattern: "packages/web/**" },
      ],
    },
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
      // ARCHITECTURE §3/§4: dependencies point one way only.
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              from: { element: { type: "ui" } },
              disallow: {
                to: { element: { types: { anyOf: ["client", "app", "desktop", "web"] } } },
              },
            },
            {
              from: { element: { type: "client" } },
              disallow: {
                to: { element: { types: { anyOf: ["ui", "app", "desktop", "web"] } } },
              },
            },
            {
              from: { element: { type: "app" } },
              disallow: {
                to: { element: { types: { anyOf: ["desktop", "web"] } } },
              },
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
    },
  },
  {
    // app uses the traditional recommended pair (rules-of-hooks + exhaustive-deps)
    // so existing exhaustive-deps disable comments resolve. Compiler rules stay
    // in UI only; app adopts them separately to avoid unrelated churn.
    files: ["packages/app/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Vendored component sources: shadcn/ui (packages/ui/src/components/ui),
    // Vercel AI Elements (packages/ui/src/ai) and shadcn's use-mobile hook are
    // kept close to upstream. The React Compiler lint rules flag several of their
    // idioms, so they are relaxed for these directories only.
    files: [
      "packages/ui/src/components/ui/**/*.{ts,tsx}",
      "packages/ui/src/ai/**/*.{ts,tsx}",
      "packages/ui/src/hooks/**/*.{ts,tsx}",
    ],
    rules: Object.fromEntries(
      Object.keys(reactHooks.rules).map((rule) => [`react-hooks/${rule}`, "off"]),
    ),
  },
  {
    // ui must not reach up into client/app or the Electron shell.
    files: ["packages/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "electron", message: "packages/ui is framework-agnostic and must not import Electron." },
          ],
          patterns: [
            { group: ["@agent-desktop/client", "@agent-desktop/client/*"], message: "packages/ui cannot import packages/client (ARCHITECTURE §3)." },
            { group: ["@agent-desktop/app", "@agent-desktop/app/*"], message: "packages/ui cannot import packages/app (ARCHITECTURE §3)." },
          ],
        },
      ],
    },
  },
  {
    // client is framework-free domain/data code — no React, no higher layers.
    files: ["packages/client/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "packages/client must stay React-free (ARCHITECTURE §3)." },
            { name: "react-dom", message: "packages/client must stay React-free (ARCHITECTURE §3)." },
          ],
          patterns: [
            { group: ["@agent-desktop/ui", "@agent-desktop/ui/*"], message: "packages/client cannot import packages/ui." },
            { group: ["@agent-desktop/app", "@agent-desktop/app/*"], message: "packages/client cannot import packages/app." },
          ],
        },
      ],
    },
  },
  {
    // app must not touch Electron or Node builtins — desktop powers arrive via PlatformAdapter.
    files: ["packages/app/**/*.{ts,tsx}"],
    // Vite/vitest tooling and tests run in Node, so they are excluded narrowly
    // from the application runtime restriction.
    ignores: [
      "packages/app/**/*.test.{ts,tsx}",
      "packages/app/**/*.config.{ts,tsx,js,mjs,cjs}",
      "packages/app/vitest.config.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Exact paths (not patterns) so sibling modules such as ./events or
          // @agent-desktop/client/http are not mistaken for the bare builtins
          // "events" and "http". The node:* family stays pattern-matched.
          paths: APP_NODE_PATH_NAMES.map((name) => ({
            name,
            message: APP_NODE_RUNTIME_MESSAGE,
          })),
          patterns: [
            {
              group: ["node:*", "electron/*"],
              message: APP_NODE_RUNTIME_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // Design-system hygiene: semantic tokens only, fixed scales only.
    files: ["packages/ui/src/primitives/**/*.{ts,tsx}", "packages/ui/src/patterns/**/*.{ts,tsx}"],
    ignores: ["**/*.stories.tsx", "**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}/]",
          message: "No hard-coded colors — use a semantic token (bg-surface, text-fg, border-border, ...).",
        },
        {
          // Only numeric/hex literals inside brackets are arbitrary VALUES
          // (p-[7px], z-[100], bg-[#fff]). Bracket VARIANTS such as
          // data-[state=open]: or [&_svg]: are ordinary Tailwind v4 syntax.
          selector: "JSXAttribute[name.name='className'] Literal[value=/-\\[[0-9#]/]",
          message: "Avoid Tailwind arbitrary values (e.g. p-[7px]) — use the fixed scale.",
        },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "packages/ui/src/test/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // CommonJS hooks loaded by electron-builder must use require().
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
