import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Intentionally minimal ESLint config: it exists to enforce ONE architectural
// boundary, not to lint the whole codebase for style. All AI model traffic must
// flow through the aiService facade (the single `callAi` gateway), so that a
// future subscription / auth / quota check can be added in one place. Components
// and other services must not reach into the AI provider internals directly.
export default [
  {
    ignores: ["dist/**", "src-tauri/**", "landing/**", "**/*.test.ts", "**/*.test.tsx"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    // The AI module itself is the gateway — it is allowed to import its internals.
    ignores: ["src/services/ai/**"],
    // The react-hooks rules are intentionally off (see below), so the codebase's
    // existing inline disable directives for them are expected to be "unused".
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Registered only so legacy inline `eslint-disable react-hooks/*` directives
      // already in the codebase resolve. We do not enforce these rules — this
      // config is intentionally scoped to the AI import boundary below.
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/services/ai/providers",
                "**/services/ai/providers/*",
                "**/services/ai/providerManager",
                "**/services/ai/providerFactory",
                "@/services/ai/providers",
                "@/services/ai/providers/*",
                "@/services/ai/providerManager",
                "@/services/ai/providerFactory",
              ],
              message:
                "Use the aiService facade (e.g. callAi / isAiAvailable). Do not import AI providers, providerManager, or providerFactory directly — all AI calls must go through the single gateway so future auth/quota gating lives in one place.",
            },
          ],
        },
      ],
    },
  },
];
