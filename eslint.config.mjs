import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [".next/**", ".next-e2e-*/**", "node_modules/**", ".pgdata/**", "tmp/**"],
  },
  {
    rules: {
      // Rows coming back from Postgres are `any` at the RPC boundary by design:
      // surface real problems, not the plumbing.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // The dashboard panels load their data in an effect on mount. The React
      // compiler rule cannot prove the setState lands after the `await`, so it
      // reports every async loader. Kept as a warning: it still flags genuinely
      // synchronous setState calls, which are the ones that cascade renders.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default config;
