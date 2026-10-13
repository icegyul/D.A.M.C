import { defineConfig } from 'vitest/config';

/**
 * Default test environment.
 *
 * Unit test files do not configure a database, and several src modules import
 * the pg pool at module scope — so a unit test that (indirectly) triggers a
 * query would otherwise connect to whatever Postgres happens to be listening
 * on the machine running the tests, e.g. an installed DAMC stack. Pointing the
 * default at a closed port keeps unit tests hermetic: connections are refused
 * instantly and anything fire-and-forget fails into its own catch.
 *
 * Database-backed files (import-pipeline, common-memory, mcp-tools-e2e)
 * override process.env.DATABASE_URL themselves before importing src, and that
 * runtime override wins over this file.
 */
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgresql://127.0.0.1:59999/damc_test'
    }
  }
});
