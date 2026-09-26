import { afterEach, beforeEach, expect, test } from "vitest";
import { Api, TestServer } from "../harness/server.ts";
import { ok, type Tuit, tuitAs } from "./cli.ts";

let server: TestServer;
let alexToken: string;
let tuit: Tuit;
let run: (...args: string[]) => Promise<string>;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00"); // Monday morning, Sydney
  alexToken = await server.mintToken("alex", "cli");
  tuit = tuitAs(server, alexToken);
  run = ok(tuit);
});

afterEach(async () => {
  await server.stop();
});

const addId = async (...args: string[]): Promise<string> =>
  JSON.parse(await run("add", ...args, "--json")).task.id;

test("a title-only capture shows up in Now", async () => {
  await run("add", "ring", "the", "vet", "about", "Milo's", "teeth");

  const now = await run("now");

  expect(now).toContain("ring the vet about Milo's teeth");
});

test("a note appears in the task's history", async () => {
  const id = await addId("Find a pool fence repairer");

  await run("note", id, "Found two candidates in Marrickville", "--next", "me");

  expect(await run("show", id)).toContain("Found two candidates in Marrickville");
});

test("an agent note without --next shows the server's explanation and fails", async () => {
  const id = await addId("Find a pool fence repairer");
  const agent = tuitAs(server, await server.mintToken("alex", "claude"));

  const r = await agent("note", id, "Found two candidates");

  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/Agents must say whose turn it is next/);
});

test("a routine done yesterday reads 'last done yesterday' and shows once after 40 days away", async () => {
  const id = await addId("Clean the gutters filter", "--every", "7");

  await run("done", id, "--at", "yesterday");

  expect(await run("show", id)).toContain("last done yesterday");
  await server.setClock("2026-11-14T09:00:00+11:00");
  const now = await run("now");
  expect(now.split(id).length - 1).toBe(1);
});

test("a dropped task is found by search as expired, with its notes kept", async () => {
  const id = await addId("Check in for the Melbourne flight");
  await run("note", id, "Qantas check-in opens 24h before", "--next", "me");

  await run("drop", id, "--reason", "flight was cancelled");

  expect(await run("search", "melbourne")).toMatch(
    new RegExp(`${id}\\s+\\[expired\\]\\s+Check in for the Melbourne flight`),
  );
  const shown = await run("show", id);
  expect(shown).toContain("Qantas check-in opens 24h before");
  expect(shown).toContain("flight was cancelled");
});

test("a queue run through the CLI matches REST, and why explains membership", async () => {
  const api = new Api(server.url, alexToken);
  const mk = async (title: string, requires: string[]) =>
    (await api.post("/api/tasks", { title, requires })).task.id as string;
  await mk("Update the budget spreadsheet", ["computer"]);
  const car = await mk("Take the car in for a service", ["car"]);
  await mk("Email the school about camp", ["computer"]);
  await mk("Water the herbs", []);
  const queue = await api.post("/api/queues", {
    name: "At the desk",
    config: { contexts: ["computer"], visible_limit: 2, order: ["oldest"] },
  });

  const cli = JSON.parse(await run("queue", queue.id, "--json"));
  const why = await run("why", car, "--queue", queue.id);

  const rest = await api.get(`/api/queues/${queue.id}`);
  const ids = (r: { result: { items: { task: { id: string } }[] } }) =>
    r.result.items.map((i) => i.task.id);
  expect(ids(cli)).toEqual(ids(rest));
  expect(cli.result.hidden_count).toBe(rest.result.hidden_count);
  const explained = await api.get(`/api/tasks/${car}/explain?queue=${queue.id}`);
  expect(why).toContain(explained.summary);
});

test("Sam's CLI can't see Alex's private task via show, search or changes", async () => {
  const secret = await addId("Sam birthday ring", "--private");
  const sam = tuitAs(server, await server.mintToken("sam", "cli"));

  const shown = await sam("show", secret);
  const found = await sam("search", "ring");
  const changes = JSON.parse((await sam("changes", "--json")).stdout);

  expect(shown.code).toBe(3);
  expect(shown.stderr).toMatch(/Not found/);
  expect(found.stdout).not.toContain(secret);
  expect(found.stdout).not.toContain("birthday");
  expect(changes.events.filter((e: { task?: { id: string } }) => e.task?.id === secret)).toEqual(
    [],
  );
});

test("changes resumes from the returned cursor", async () => {
  await run("add", "Book the plumber");
  const first = await run("changes");
  const cursor = /cursor: (\d+)/.exec(first)?.[1] as string;
  await run("add", "Renew car rego");

  const second = await run("changes", "--after", cursor);

  expect(first).toContain("Book the plumber");
  expect(second).toContain("Renew car rego");
  expect(second).not.toContain("Book the plumber");
});

test("now --json has the same shape as REST /api/now", async () => {
  await run("add", "Replace the smoke alarm battery");
  await run("add", "Book the plumber", "--deadline", "tomorrow");

  const cli = JSON.parse(await run("now", "--json"));

  const rest = await new Api(server.url, alexToken).get("/api/now");
  expect(Object.keys(cli).sort()).toEqual(Object.keys(rest).sort());
  expect(cli).toEqual(rest);
});

test("a task added through the CLI survives a server restart", async () => {
  const id = await addId("Replace the smoke alarm battery");

  await server.restart();

  expect(await run("show", id)).toContain("Replace the smoke alarm battery");
});

test("login saves a config that later commands use", async () => {
  const bare = tuitAs(server, null);

  await ok(bare)("login", "--url", server.url, "--token", alexToken);
  await ok(bare)("add", "Pick up the dry cleaning");

  expect(await ok(bare)("now")).toContain("Pick up the dry cleaning");
});

test("a unique id prefix is accepted in place of the full id", async () => {
  const id = await addId("Renew car rego");

  const shown = await run("show", id.slice(0, 3));

  expect(shown).toContain(`${id}  (rev 1)`);
});

test("a stale --rev is a conflict that says to re-read", async () => {
  const id = await addId("Renew car rego");
  await run("edit", id, "--brief", "edited on the phone");

  const r = await tuit("edit", id, "--brief", "agent retry", "--rev", "1");

  expect(r.code).toBe(4);
  expect(r.stderr).toMatch(/Re-read it/);
  expect(r.stderr).toContain("--rev 2");
});
