import { defineConfig, globalIgnores } from "eslint/config";
import noComments from "eslint-plugin-no-comments";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist", "node_modules", "coverage"]),
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
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
