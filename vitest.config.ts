import { resolve } from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./test/wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(resolve("migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
