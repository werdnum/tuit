import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { waitFor } from "../harness/postgres.ts";
import { FakeApns, FakeWebPush } from "../harness/push.ts";
import { type Api, TestServer } from "../harness/server.ts";

let server: TestServer;
let push: FakeWebPush;
let alex: Api;
let sam: Api;

const AFTERNOON = "2026-10-05T14:00:00+11:00";

beforeEach(async () => {
  push = await FakeWebPush.start();
  server = await TestServer.start();
  await server.setClock(AFTERNOON);
  alex = await server.human("alex");
  sam = await server.human("sam");
});

afterEach(async () => {
  await server.stop();
  await push.stop();
});

async function turnOn(api: Api, device: string): Promise<any> {
  return api.post("/api/notifications/devices", { kind: "web", ...push.subscription(device) });
}

async function add(api: Api, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await api.post("/api/tasks", { title, ...extra })).task.id;
}

/** Wait until `device` has received `n` notifications, then return them. */
async function pushes(device: string, n: number) {
  return waitFor(`${n} notification(s) on ${device}`, async () => {
    const got = push.received.filter((r) => r.device === device);
    return got.length >= n ? got : undefined;
  });
}

describe("web push", () => {
  test("a handoff reaches the person it was handed to, encrypted, with a link to the task", async () => {
    await turnOn(alex, "alex-phone");
    const id = await add(sam, "Book the plumber");
    await sam.post(`/api/tasks/${id}/handoff`, { to: "alex", next_action: "Ring Jim's" });

    const [msg] = await pushes("alex-phone", 1);
    expect(msg).toMatchObject({
      title: "Book the plumber",
      body: "Sam handed this to you · Next: Ring Jim's",
      url: `${server.url}/tasks/${id}`,
      taskId: id,
    });
    expect(msg?.headers.authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(msg?.headers["content-encoding"]).toBe("aes128gcm");

    const log = await alex.get("/api/notifications");
    expect(log.recent).toMatchObject([
      { task: { id, title: "Book the plumber" }, category: "handoff", status: "sent" },
    ]);
  });

  test("your own changes never notify you; an agent acting for you does", async () => {
    await turnOn(alex, "alex-phone");
    await alex.put("/api/notifications/settings", {
      rules: [{ when: ["progress"], whose: "any" }],
    });
    const id = await add(alex, "Renew car rego");
    await alex.post(`/api/tasks/${id}/checkpoint`, { note: "Found the form" });
    const agent = await server.api("alex", "claude");
    await agent.post(`/api/tasks/${id}/checkpoint`, {
      note: "Paid online, receipt in Drive",
      next_actor: "alex",
    });

    const got = await pushes("alex-phone", 1);
    expect(got.map((g) => g.body)).toEqual(["agent:claude wrote: Paid online, receipt in Drive"]);
  });

  test("one write that hands off and changes state arrives as one notification", async () => {
    await turnOn(alex, "alex-phone");
    await alex.put("/api/notifications/settings", {
      rules: [{ when: ["handoff", "progress", "closed", "ready"], whose: "any" }],
    });
    const id = await add(sam, "Chase the insurer");
    await sam.post(`/api/tasks/${id}/checkpoint`, {
      note: "Waiting on their reply",
      state: "waiting",
      waiting: { kind: "reply", for: "insurer" },
      next_actor: "sam",
    });
    await sam.post(`/api/tasks/${id}/checkpoint`, {
      note: "They replied, over to Alex",
      state: "open",
      next_actor: "alex",
    });
    const marker = await add(sam, "Marker");
    await sam.post(`/api/tasks/${marker}/handoff`, { to: "alex" });

    const got = await pushes("alex-phone", 3);
    expect(got.map((g) => [g.title, g.body.split(" · ")[0]])).toEqual([
      ["Chase the insurer", "Sam wrote: Waiting on their reply"],
      ["Chase the insurer", "Sam handed this to you"],
      ["Marker", "Sam handed this to you"],
    ]);
  });

  test("rules filter by area, whose task it is and who made the change", async () => {
    await turnOn(alex, "alex-phone");
    await alex.put("/api/notifications/settings", {
      rules: [{ when: ["progress", "closed"], whose: "any", area: "home", from: "agents" }],
    });
    const fa = await server.api("sam", "family-assistant");
    const home = await add(sam, "#home fix the gate");
    const cluster = await add(sam, "#cluster upgrade k3s");
    await sam.post(`/api/tasks/${home}/checkpoint`, { note: "by a person" });
    await fa.post(`/api/tasks/${cluster}/checkpoint`, { note: "wrong area", next_actor: "sam" });
    await fa.post(`/api/tasks/${home}/checkpoint`, { note: "ordered a latch", next_actor: "sam" });
    await fa.post(`/api/tasks/${home}/complete`, {});

    const got = await pushes("alex-phone", 2);
    expect(got.map((g) => g.body)).toEqual([
      "agent:family-assistant wrote: ordered a latch",
      "agent:family-assistant marked it done",
    ]);
  });

  test("whose: mine and owned follow the task, not the change", async () => {
    await turnOn(alex, "alex-phone");
    await alex.put("/api/notifications/settings", {
      rules: [
        { when: ["closed"], whose: "owned" },
        { when: ["progress"], whose: "mine" },
      ],
    });
    const mineToDo = await add(sam, "Sam's task, Alex's turn", { next_actor: "alex" });
    const alexOwns = await add(alex, "Alex's task, Sam's turn", { next_actor: "sam" });
    const samsOwn = await add(sam, "Sam's own");
    await sam.post(`/api/tasks/${samsOwn}/checkpoint`, { note: "not Alex's business" });
    await sam.post(`/api/tasks/${samsOwn}/complete`, {});
    await sam.post(`/api/tasks/${mineToDo}/checkpoint`, { note: "left the number on the fridge" });
    await sam.post(`/api/tasks/${alexOwns}/complete`, {});

    const got = await pushes("alex-phone", 2);
    expect(got.map((g) => g.title)).toEqual(["Sam's task, Alex's turn", "Alex's task, Sam's turn"]);
  });

  test("someone else's private task never notifies anyone else", async () => {
    await turnOn(alex, "alex-phone");
    await alex.put("/api/notifications/settings", { rules: [{ when: ["created"], whose: "any" }] });
    await add(sam, "Surprise party for Alex", { visibility: "private" });
    await add(sam, "Buy milk");

    const got = await pushes("alex-phone", 1);
    expect(got.map((g) => g.title)).toEqual(["Buy milk"]);
  });

  test("quiet hours hold notifications and release one summary when they end", async () => {
    await turnOn(alex, "alex-phone");
    await alex.put("/api/notifications/settings", {
      quiet: { from: "22:00", to: "07:00" },
      rules: [
        { when: ["handoff"], whose: "mine" },
        { when: ["deadline"], whose: "mine", quiet_ok: true },
      ],
    });
    await server.setClock("2026-10-05T23:00:00+11:00");
    const a = await add(sam, "Sign the school form");
    const b = await add(sam, "Pay the water bill");
    await sam.post(`/api/tasks/${a}/handoff`, { to: "alex" });
    await sam.post(`/api/tasks/${b}/handoff`, { to: "alex" });
    // Urgent enough to break through.
    await add(sam, "Lodge the tax return", {
      next_actor: "alex",
      deadline: { at: "2026-10-06T09:00:00+11:00" },
    });

    const urgent = await pushes("alex-phone", 1);
    expect(urgent[0]).toMatchObject({ title: "Lodge the tax return" });
    expect(urgent[0]?.body).toMatch(/^Deadline tomorrow 9am/);
    // Capturing the tax return into Alex's hands was a handoff, held like the others; the
    // summary leaves it out because its deadline already broke through.
    const held = await alex.get("/api/notifications");
    expect(held.recent.filter((e: any) => e.status === "held")).toHaveLength(3);

    await server.setClock("2026-10-06T07:05:00+11:00");
    const after = await pushes("alex-phone", 2);
    expect(after[1]).toMatchObject({
      title: "2 updates while notifications were quiet",
      body: "Sign the school form · Pay the water bill",
    });
    const log = await alex.get("/api/notifications");
    expect(log.recent.filter((e: any) => e.status === "held")).toHaveLength(0);
  });

  test("a push service outage is retried, not dropped", async () => {
    await turnOn(alex, "alex-phone");
    push.status.set("alex-phone", 503);
    const id = await add(sam, "Call the bank");
    await sam.post(`/api/tasks/${id}/handoff`, { to: "alex" });
    await waitFor("a failed send waiting to retry", async () => {
      const { recent } = await alex.get("/api/notifications");
      return recent[0]?.status === "retry" ? true : undefined;
    });

    push.status.delete("alex-phone");
    await server.setClock("2026-10-05T14:01:00+11:00");
    const [msg] = await pushes("alex-phone", 1);
    expect(msg).toMatchObject({ title: "Call the bank", body: "Earlier: handed over", taskId: id });
    expect((await alex.get("/api/notifications")).recent[0].status).toBe("sent");
    // Withdrawing a device is idempotent, for a phone signing out after it was removed.
    const { devices } = await alex.get("/api/notifications");
    expect((await alex.call("DELETE", `/api/notifications/devices/${devices[0].id}`)).status).toBe(
      200,
    );
    expect((await alex.call("DELETE", `/api/notifications/devices/${devices[0].id}`)).status).toBe(
      200,
    );
  });

  test("a device that can't be sent to doesn't stop the others", async () => {
    await alex.post("/api/notifications/devices", {
      kind: "web",
      ...push.subscription("broken"),
      keys: { p256dh: "not-a-key", auth: "x" },
    });
    await turnOn(alex, "alex-phone");
    const id = await add(sam, "Mow the lawn");
    await sam.post(`/api/tasks/${id}/handoff`, { to: "alex" });
    const [msg] = await pushes("alex-phone", 1);
    expect(msg?.body).toBe("Sam handed this to you");
    expect((await alex.get("/api/notifications")).recent[0].status).toBe("sent");
  });

  test("a subscription the push service says is gone is forgotten", async () => {
    await turnOn(alex, "old-laptop");
    await turnOn(alex, "alex-phone");
    push.status.set("old-laptop", 410);
    const id = await add(sam, "Return the library books");
    await sam.post(`/api/tasks/${id}/handoff`, { to: "alex" });
    await pushes("alex-phone", 1);
    await waitFor("old laptop forgotten", async () => {
      const { devices } = await alex.get("/api/notifications");
      return devices.length === 1 ? devices : undefined;
    });
  });

  test("settings and devices belong to the person, not to agents or other push hosts", async () => {
    const agent = await server.api("alex", "claude");
    const r = await agent.call("GET", "/api/notifications");
    expect(r.status).toBe(403);
    const bad = await alex.call("POST", "/api/notifications/devices", {
      kind: "web",
      endpoint: "https://evil.example.com/push",
      keys: { p256dh: "x", auth: "y" },
    });
    expect(bad.status).toBe(400);
    const apns = await alex.call("POST", "/api/notifications/devices", {
      kind: "apns",
      token: "ab".repeat(32),
      environment: "sandbox",
    });
    expect(apns.status).toBe(400);
    expect(apns.json.message).toMatch(/aren't set up/);
  });

  test("a test notification reaches every device", async () => {
    await turnOn(alex, "alex-phone");
    await turnOn(alex, "alex-laptop");
    expect(await alex.post("/api/notifications/test")).toEqual({ sent: 2, failed: 0 });
    expect((await pushes("alex-laptop", 1))[0]?.body).toMatch(/working/);
  });

  test("nothing is repeated after a restart", async () => {
    await turnOn(alex, "alex-phone");
    const id = await add(sam, "Book flights");
    await sam.post(`/api/tasks/${id}/handoff`, { to: "alex" });
    await pushes("alex-phone", 1);
    await server.restart();
    const id2 = await add(sam, "Book hotel");
    await sam.post(`/api/tasks/${id2}/handoff`, { to: "alex" });
    const got = await pushes("alex-phone", 2);
    expect(got.map((g) => g.title)).toEqual(["Book flights", "Book hotel"]);
  });
});

describe("iPhone app (APNs)", () => {
  let apns: FakeApns;

  beforeEach(async () => {
    await server.stop();
    apns = await FakeApns.start();
    server = await TestServer.start({
      env: {
        TUIT_IOS_APP_IDS: "TEAM123456.dev.test.tuit",
        APNS_KEY_ID: "KEY1234567",
        APNS_AUTH_KEY: apns.keyPem.replace(/\n/g, "\\n"),
        APNS_HOST: apns.url,
      },
    });
    await server.setClock(AFTERNOON);
    alex = await server.human("alex");
    sam = await server.human("sam");
  });

  afterEach(async () => {
    await server.stop();
    await apns.stop();
  });

  test("a handoff is pushed to the app with a signed provider token and the task id", async () => {
    const token = "0a".repeat(32);
    const device = await alex.post("/api/notifications/devices", {
      kind: "apns",
      token,
      environment: "sandbox",
      label: "Alex's iPhone",
    });
    expect(device).toMatchObject({ kind: "apns", label: "Alex's iPhone", token });
    const id = await add(sam, "Pick up the dry cleaning");
    await sam.post(`/api/tasks/${id}/handoff`, { to: "alex" });

    const req = await waitFor("APNs request", async () => apns.received[0]);
    expect(req.path).toBe(`/3/device/${token}`);
    expect(req.headers["apns-topic"]).toBe("dev.test.tuit");
    expect(req.headers["apns-push-type"]).toBe("alert");
    expect(req.payload).toMatchObject({
      aps: { alert: { title: "Pick up the dry cleaning", body: "Sam handed this to you" } },
      task_id: id,
      url: `${server.url}/tasks/${id}`,
    });
    const jwt = String(req.headers.authorization).replace(/^bearer /, "");
    const { payload, protectedHeader } = await jwtVerify(jwt, apns.publicKey);
    expect(protectedHeader).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect(payload.iss).toBe("TEAM123456");
  });

  test("an uninstalled app's token is forgotten, and the app can remove its own", async () => {
    const gone = "0b".repeat(32);
    const kept = "0c".repeat(32);
    apns.answer.set(gone, [410, "Unregistered"]);
    for (const token of [gone, kept]) {
      await alex.post("/api/notifications/devices", {
        kind: "apns",
        token,
        environment: "production",
      });
    }
    const id = await add(sam, "Feed the cat");
    await sam.post(`/api/tasks/${id}/handoff`, { to: "alex" });
    await waitFor("push to the kept device", async () => apns.received[0]);
    await waitFor("unregistered token removed", async () => {
      const { devices } = await alex.get("/api/notifications");
      return devices.length === 1 ? true : undefined;
    });
    const r = await alex.call("DELETE", `/api/notifications/devices/${kept}`);
    expect(r.status).toBe(200);
    expect((await alex.get("/api/notifications")).devices).toEqual([]);
  });
});
