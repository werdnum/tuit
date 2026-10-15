import { serve } from "@hono/node-server";
import { buildApp, seedUsers } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Database } from "./db/db.ts";

const config = loadConfig();
const db = new Database(config.databaseUrl);
await db.migrate();
await seedUsers(db, config);
const { app, http } = buildApp(config, db);
app.live.start();
// Every change to the feed wakes the notifier, through the same LISTEN connection as live pages.
app.live.subscribe("", () => void app.notifier.kick());
void app.notifier.kick();

const timer = setInterval(() => {
  app
    .sweepNow()
    .catch((err) => console.error("sweep failed", err))
    // Also on a timer, because quiet hours end with no event to announce it.
    .then(() => app.notifier.kick());
}, config.sweepIntervalMs);

const server = serve({ fetch: http.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(
    `tuit listening on http://${info.address}:${info.port} (public ${config.publicUrl.origin})`,
  );
});

async function shutdown(): Promise<void> {
  clearInterval(timer);
  server.close();
  await app.live.stop();
  app.notifier.close();
  await db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
