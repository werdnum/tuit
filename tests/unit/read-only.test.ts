import pg from "pg";
import { afterEach, expect, test } from "vitest";
import { Database } from "../../src/db/db.ts";
import { createDatabase } from "../harness/postgres.ts";

let db: Database | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function freshDatabase(): Promise<string> {
  const adminUrl = process.env.TUIT_TEST_PG_URL;
  if (!adminUrl) throw new Error("TUIT_TEST_PG_URL not set (global setup should start postgres)");
  return createDatabase(adminUrl);
}

test("a read-only server is refused at connect time instead of failing every write", async () => {
  const url = await freshDatabase();
  const admin = new pg.Client(url);
  await admin.connect();
  // New sessions on this database start read-only, as they would on a standby.
  await admin.query(
    `ALTER DATABASE ${new URL(url).pathname.slice(1)} SET default_transaction_read_only = on`,
  );
  await admin.end();

  db = new Database(url);

  await expect(db.query("SELECT 1")).rejects.toThrow(/read-only PostgreSQL server/);
  // The refused connection is not kept for the next caller.
  expect(db.pool.totalCount).toBe(0);
});

test("a writable server is used as normal", async () => {
  db = new Database(await freshDatabase());

  await db.query("CREATE TABLE t (i int)");
  await db.query("INSERT INTO t VALUES (1)");

  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM t");
  expect(rows).toEqual([{ n: 1 }]);
});
