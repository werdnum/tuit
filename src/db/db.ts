import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

// Keep DATE columns as 'YYYY-MM-DD' strings: a calendar date must never become a JS Date
// (which is an instant at local midnight).
pg.types.setTypeParser(1082, (v: string) => v);
// bigint (bigserial seq/ids) fits comfortably in a JS number for this application.
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Queryable = Pick<pg.PoolClient, "query">;

export class Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /** Run `body` in a transaction; rolls back on any thrown error. */
  async tx<T>(body: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await body(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    const dir = join(import.meta.dirname, "migrations");
    await this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(4242001)");
      await c.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const done = new Set(
        (await c.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
          (r) => r.name,
        ),
      );
      for (const file of readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        if (done.has(file)) continue;
        await c.query(readFileSync(join(dir, file), "utf8"));
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      }
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
