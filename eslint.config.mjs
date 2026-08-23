import { defineConfig, globalIgnores } from "eslint/config";
import noComments from "eslint-plugin-no-comments";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "dist",
    "node_modules",
    "coverage",
    "e2e/fixture/.next*",
    "e2e/fixture/.e2e",
    "e2e/fixture/next-env.d.ts",
  ]),
  {
    files: [
      "src/**/*.ts",
      "tests/**/*.ts",
      "scripts/**/*.ts",
      "e2e/**/*.ts",
      "e2e/**/*.tsx",
      "e2e/**/*.mjs",
    ],
    extends: [tseslint.configs.recommended],
    plugins: { "no-comments": noComments },
    rules: {
      "no-comments/disallowComments": [
        "error",
        { allow: ["\\*", "eslint", "global", "@ts-", "prettier-ignore"] },
      ],
    },
  },
]);
