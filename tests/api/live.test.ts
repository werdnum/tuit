import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";
import { signIn } from "../harness/session.ts";

interface LiveEvent {
  event: string;
  data: string;
  id?: string;
}

/** A reader over the web UI's live stream, as the browser's EventSource would see it. */
class Stream {
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  readonly headers: Headers;

  constructor(res: Response) {
    if (!res.body) throw new Error("no body");
    this.reader = res.body.getReader();
    this.headers = res.headers;
  }

  /** The next event, skipping heartbeat comments. */
  async next(): Promise<LiveEvent> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const ev: LiveEvent = { event: "message", data: "" };
        let fields = 0;
        for (const line of block.split("\n")) {
          const [k, ...rest] = line.split(":");
          const v = rest.join(":").replace(/^ /, "");
          if (k === "event") ev.event = v;
          else if (k === "data") ev.data = v;
          else if (k === "id") ev.id = v;
          else continue;
          fields++;
        }
        if (fields > 0) return ev;
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("stream ended");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

let server: TestServer;
let alex: Api;
const streams: Stream[] = [];

async function open(user: string, after?: string): Promise<Stream> {
  const session = await signIn(server, user);
  const res = await session.fetch(after ? `/live?after=${after}` : "/live");
  expect(res.status).toBe(200);
  const s = new Stream(res);
  streams.push(s);
  expect((await s.next()).event).toBe("ready");
  return s;
}

async function lastSeq(api: Api): Promise<string> {
  const { cursor } = await api.get("/api/changes?after=0&limit=500");
  return cursor;
}

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "cli");
});

afterEach(async () => {
  for (const s of streams.splice(0)) await s.close().catch(() => {});
  await server.stop();
});

test("a signed-in page hears about a change someone else makes", async () => {
  const sam = await open("sam");

  await alex.post("/api/tasks", { title: "Book the chimney sweep" });

  const ev = await sam.next();
  expect(ev.event).toBe("change");
  expect(ev.id).toBe(await lastSeq(alex));
  expect(sam.headers.get("content-type")).toMatch(/^text\/event-stream/);
  expect(sam.headers.get("x-accel-buffering")).toBe("no");
});

test("a private task changing wakes nobody else, and the cursor doesn't reveal it", async () => {
  const samApi = await server.api("sam", "check");
  const { task } = await alex.post("/api/tasks", { title: "Clean the gutters" });
  const before = await lastSeq(alex);
  const sam = await open("sam", before);

  await alex.post("/api/tasks", { title: "Sam's birthday present", visibility: "private" });
  // Sam's own snooze wakes Sam's page without moving the feed: the first thing Sam hears.
  await samApi.post(`/api/tasks/${task.id}/snooze`, { until: "2026-10-12" });
  await alex.post("/api/tasks", { title: "Oil the gate" });

  const first = await sam.next();
  const second = await sam.next();
  expect([first.event, first.id]).toEqual(["change", before]);
  expect(JSON.parse(first.data)).toMatchObject({ cursor: Number(before), at: expect.any(Number) });
  expect([second.event, second.id]).toEqual(["change", await lastSeq(alex)]);
  expect(JSON.parse(second.data)).toEqual({ cursor: Number(await lastSeq(alex)) });
});

test("snoozing on one device updates that person's other devices, not anyone else's", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Descale the kettle" });
  const cursor = await lastSeq(alex);
  const alexPhone = await open("alex", cursor);
  const sam = await open("sam", cursor);

  await alex.post(`/api/tasks/${task.id}/snooze`, { until: "2026-10-12" });
  expect((await alexPhone.next()).event).toBe("change");

  await alex.post("/api/tasks", { title: "Oil the gate" });
  const ev = await sam.next();
  expect(ev.event).toBe("change");
  expect(ev.id).toBe(await lastSeq(alex));
});

test("a page that reconnects catches up on what it missed", async () => {
  const before = await lastSeq(alex);
  await alex.post("/api/tasks", { title: "Renew the car registration" });

  const s = await open("alex", before);

  const ev = await s.next();
  expect(ev.event).toBe("change");
  expect(ev.id).toBe(await lastSeq(alex));
});

test("the live stream is only for a signed-in session", async () => {
  const anon = await fetch(`${server.url}/live`);
  const bearer = await fetch(`${server.url}/live`, {
    headers: { authorization: `Bearer ${alex.token}` },
  });

  expect(anon.status).toBe(401);
  expect(bearer.status).toBe(401);
});
