import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // `vscode` is injected by the extension host and has no npm package to
    // resolve, so anything importing it is untestable until it is aliased.
    alias: {
      vscode: path.resolve(here, "test/vscode-stub.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
