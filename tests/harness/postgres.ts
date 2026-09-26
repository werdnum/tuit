import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || !addr) return reject(new Error("no port"));
      srv.close(() => resolve(addr.port));
    });
  });
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}: ${String(lastErr ?? "")}`);
}

/**
 * A throwaway PostgreSQL cluster for the test run, using the local server binaries
 * (initdb/pg_ctl). Set TEST_DATABASE_URL to use an existing server instead.
 */
export async function startPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  if (process.env.TEST_DATABASE_URL) {
    return { url: process.env.TEST_DATABASE_URL, stop: async () => {} };
  }
  // Short path: unix socket paths are limited to ~100 bytes.
  const dir = mkdtempSync(join(tmpdir(), "tuit-pg-"));
  const port = await freePort();
  execFileSync("initdb", ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust", "--no-sync"], {
    stdio: "ignore",
  });
  const proc = spawn(
    "postgres",
    [
      "-D",
      join(dir, "data"),
      "-p",
      String(port),
      "-k",
      dir,
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "fsync=off",
      "-c",
      "max_connections=300",
    ],
    { stdio: "ignore" },
  );
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  await waitFor("postgres", async () => {
    const c = new pg.Client(url);
    await c.connect();
    await c.end();
    return true;
  });
  return {
    url,
    stop: async () => {
      proc.kill("SIGINT");
      await new Promise((r) => proc.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function createDatabase(adminUrl: string): Promise<string> {
  const name = `tuit_test_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client(adminUrl);
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.href;
}
