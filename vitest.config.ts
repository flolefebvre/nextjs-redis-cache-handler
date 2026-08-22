import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const INTEGRATION_TESTS = ["src/**/*.integration.test.ts", "tests/**/*.integration.test.ts"];

export default defineConfig({
  resolve: {
    alias: {
      /**
       * The Zero-config entry re-exports this internal subpath, and the `exports` map
       * answers it with the built output — which the gate compiles only after it has run
       * the tests. A test loading `handler.ts` from source resolves it here instead, to
       * the same Node.js target `tsconfig.json`'s `paths` entry names for the typechecker.
       */
      "@flefebvre/nextjs-redis-cache-handler/handler-target": fileURLToPath(
        new URL("./src/handler.node.ts", import.meta.url),
      ),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...INTEGRATION_TESTS],
          clearMocks: true,
          restoreMocks: true,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: INTEGRATION_TESTS,
          globalSetup: ["tests/global-setup.ts"],
          pool: "forks",
          isolate: true,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
