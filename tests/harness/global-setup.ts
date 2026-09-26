import { startPostgres } from "./postgres.ts";

/** Shared by Vitest and Playwright: one Postgres cluster per run, a database per server. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const pg = await startPostgres();
  process.env.TUIT_TEST_PG_URL = pg.url;
  return pg.stop;
}
