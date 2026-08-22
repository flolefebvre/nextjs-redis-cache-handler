import { configDefaults, defineConfig } from "vitest/config";

const INTEGRATION_TESTS = ["src/**/*.integration.test.ts", "tests/**/*.integration.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
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
