import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const INTEGRATION_TESTS = ["src/**/*.integration.test.ts", "tests/**/*.integration.test.ts"];
const E2E_TESTS = ["e2e/**/*.e2e.test.ts"];

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
          include: ["src/**/*.test.ts", "tests/**/*.test.ts", "e2e/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...INTEGRATION_TESTS, ...E2E_TESTS],
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
      {
        extends: true,
        test: {
          name: "e2e",
          environment: "node",
          include: E2E_TESTS,
          globalSetup: ["e2e/global-setup.ts"],
          pool: "forks",
          isolate: true,
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
