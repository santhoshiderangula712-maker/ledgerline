import { defineConfig } from "vitest/config";
import fs from "node:fs";

// Tests NEVER use .env. They read ONLY .env.test.local, so they cannot touch the real database.
function testDatabaseUrl(): string {
  if (!fs.existsSync(".env.test.local"))
    throw new Error("Missing .env.test.local (DATABASE_URL of the Neon test branch)");
  const line = fs
    .readFileSync(".env.test.local", "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error(".env.test.local has no DATABASE_URL= line");
  const url = line.slice("DATABASE_URL=".length).trim();
  if (!url) throw new Error("DATABASE_URL in .env.test.local is empty");
  return url;
}

export default defineConfig({
  test: {
    env: { DATABASE_URL: testDatabaseUrl() },
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false, // some tests take table-level locks; run files one at a time
  },
});