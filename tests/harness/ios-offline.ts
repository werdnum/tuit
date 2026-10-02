/** Real REST/Postgres fixture with controllable disconnection and lost write responses. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { startPostgres } from "./postgres.ts";
import { TestServer } from "./server.ts";

const pg = await startPostgres();
process.env.TUIT_TEST_PG_URL = pg.url;
const backend = await TestServer.start({ devLogin: true });
const person = await backend.human("alex");
const task = await person.post("/api/tasks", {
  title: "Offline fixture task",
  brief: "A saved brief for a flight",
});
let mode = "online";
let configReads = 0;
let droppedWrites = 0;
const proxy = createServer(async (req, res) => {
  if (req.url === "/config") {
    configReads += 1;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ base: "http://localhost:18089", token: person.token, taskID: task.task.id }),
    );
    return;
  }
  if (req.url?.startsWith("/mode/")) {
    mode = req.url.slice(6);
    res.end("ok");
    return;
  }
  if (mode === "offline") {
    req.socket.destroy();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const reply = await fetch(backend.url + req.url, {
      method: req.method,
      headers: { authorization: `Bearer ${person.token}`, "content-type": "application/json" },
      body: body.length ? body : undefined,
    });
    const data = Buffer.from(await reply.arrayBuffer());
    if (mode === "lose-write" && req.method !== "GET") {
      droppedWrites += 1;
      mode = "offline";
      req.socket.destroy();
      return;
    }
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(data);
  } catch {
    res.writeHead(502);
    res.end();
  }
});
try {
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(18089, "127.0.0.1", resolve);
  });
} catch (error) {
  await backend.stop();
  await pg.stop();
  throw error;
}
console.log("Offline test fixture ready on localhost:18089 (credentials stay in memory).");
const child = spawn(
  "xcodebuild",
  [
    "-project",
    "ios/Tuit.xcodeproj",
    "-scheme",
    "Tuit",
    "-destination",
    process.env.TUIT_IOS_DESTINATION ?? "platform=iOS Simulator,name=iPhone 17 Pro",
    "-derivedDataPath",
    process.env.TUIT_IOS_DERIVED_DATA ?? "/tmp/tuit-offline-derived",
    "-parallel-testing-enabled",
    "NO",
    "test",
  ],
  { stdio: "inherit" },
);
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
try {
  const code = await new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? 1)),
  );
  process.exitCode = code;
  if (code === 0 && (configReads < 4 || droppedWrites < 1)) {
    throw new Error("Offline integration/UI coverage did not run against the real fixture");
  }
} finally {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await backend.stop();
  await pg.stop();
}
