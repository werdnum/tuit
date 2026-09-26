import { serve } from "@hono/node-server";
import { buildApp, seedUsers } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Database } from "./db/db.ts";

const config = loadConfig();
const db = new Database(config.databaseUrl);
await db.migrate();
await seedUsers(db, config);
const { app, http } = buildApp(config, db);

const timer = setInterval(() => {
  app.sweepNow().catch((err) => console.error("sweep failed", err));
}, config.sweepIntervalMs);

const server = serve({ fetch: http.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(
    `tuit listening on http://${info.address}:${info.port} (public ${config.publicUrl.origin})`,
  );
});

async function shutdown(): Promise<void> {
  clearInterval(timer);
  server.close();
  await db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
