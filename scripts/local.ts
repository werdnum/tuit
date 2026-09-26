import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

// Run the app locally against a persistent Postgres in .tmp/localpg, with the pick-a-user dev
// login (no identity provider needed). Data survives restarts; delete .tmp/localpg to reset.

const root = join(import.meta.dirname, "..");
const data = join(root, ".tmp", "localpg");
const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
if (!existsSync(data)) {
  execFileSync("initdb", ["-D", data, "-U", "postgres", "-A", "trust"], { stdio: "inherit" });
}
try {
  execFileSync("pg_ctl", ["-D", data, "status"], { stdio: "ignore" });
} catch {
  execFileSync(
    "pg_ctl",
    [
      "-D",
      data,
      "-l",
      join(data, "server.log"),
      "-o",
      `-p ${port} -k /tmp -c listen_addresses=127.0.0.1`,
      "-w",
      "start",
    ],
    {
      stdio: "inherit",
    },
  );
}
const admin = new pg.Client(`postgres://postgres@127.0.0.1:${port}/postgres`);
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'tuit'");
if (exists.rowCount === 0) await admin.query("CREATE DATABASE tuit");
await admin.end();

const env = {
  ...process.env,
  DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/tuit`,
  PUBLIC_URL: process.env.PUBLIC_URL ?? "http://localhost:8080",
  PORT: process.env.PORT ?? "8080",
  TUIT_USERS: process.env.TUIT_USERS ?? "alex:alex@example.com:Alex,sam:sam@example.com:Sam",
  TUIT_DEV_LOGIN: "1",
};
console.log(`DATABASE_URL=${env.DATABASE_URL}`);
const child = spawn(process.execPath, ["--watch", "src/server.ts"], {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
