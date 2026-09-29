import { afterEach, beforeEach, expect, test } from "vitest";
import { Api, TestServer } from "../harness/server.ts";

let server: TestServer;
let alex: Api;
let sam: Api;
let taskId: string;

const QUOTE = "https://drive.google.com/file/d/1AbCdEf/view?usp=sharing";

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "cli");
  sam = await server.api("sam", "family-assistant");
  const { task } = await alex.post("/api/tasks", { title: "Fix the pool fence" });
  taskId = task.id;
});

afterEach(async () => {
  await server.stop();
});

test("a link attached to a task shows on the task with who added it", async () => {
  const { task } = await sam.post(`/api/tasks/${taskId}/attachments`, {
    url: QUOTE,
    title: "Repairer's quote",
    mime_type: "application/pdf",
  });

  expect(task.attachments).toEqual([
    expect.objectContaining({
      url: QUOTE,
      title: "Repairer's quote",
      mime_type: "application/pdf",
      added_by: { user: "sam", agent: "family-assistant" },
    }),
  ]);
  const read = await alex.get(`/api/tasks/${taskId}`);
  expect(read.task.attachments.map((a: any) => a.title)).toEqual(["Repairer's quote"]);
});

test("attaching is recorded in the history and announced on the change feed", async () => {
  const { cursor } = await alex.get("/api/changes?after=latest");

  await alex.post(`/api/tasks/${taskId}/attachments`, { url: QUOTE, title: "Quote" });

  const { activity } = await alex.get(`/api/tasks/${taskId}`);
  expect(activity.at(-1)).toMatchObject({ kind: "attached", body: "Quote" });
  const { events } = await alex.get(`/api/changes?after=${cursor}`);
  expect(events).toEqual([
    expect.objectContaining({ type: "updated", data: { fields: ["attachments"] } }),
  ]);
});

test("without a title, the link's address stands in for one", async () => {
  const { task } = await alex.post(`/api/tasks/${taskId}/attachments`, {
    url: "https://example.com/receipts/fence.pdf",
  });

  expect(task.attachments[0].title).toBe("example.com/receipts/fence.pdf");
});

test("a link with a malformed escape still attaches, titled as written", async () => {
  const { task } = await alex.post(`/api/tasks/${taskId}/attachments`, {
    url: "https://example.com/files/%E9",
  });

  expect(task.attachments[0].title).toBe("example.com/files/%E9");
});

test("attaching the same link twice keeps one", async () => {
  await alex.post(`/api/tasks/${taskId}/attachments`, { url: QUOTE });
  const { task } = await alex.post(`/api/tasks/${taskId}/attachments`, { url: QUOTE });

  expect(task.attachments).toHaveLength(1);
});

test("only openable http(s) links are accepted", async () => {
  const script = await alex.call("POST", `/api/tasks/${taskId}/attachments`, {
    url: "javascript:alert(1)",
  });
  const notALink = await alex.call("POST", `/api/tasks/${taskId}/attachments`, {
    url: "the quote in my email",
  });
  const withPassword = await alex.call("POST", `/api/tasks/${taskId}/attachments`, {
    url: "https://me:hunter2@example.com/file",
  });

  expect([script.status, notALink.status, withPassword.status]).toEqual([400, 400, 400]);
  const { task } = await alex.get(`/api/tasks/${taskId}`);
  expect(task.attachments).toEqual([]);
});

test("removing an attachment drops the link but the history keeps it", async () => {
  const { task } = await alex.post(`/api/tasks/${taskId}/attachments`, { url: QUOTE, title: "Q" });

  const after = await alex.call(
    "DELETE",
    `/api/tasks/${taskId}/attachments/${task.attachments[0].id}`,
  );

  expect(after.status).toBe(200);
  expect(after.json.task.attachments).toEqual([]);
  const { activity } = await alex.get(`/api/tasks/${taskId}`);
  expect(activity.at(-1)).toMatchObject({ kind: "detached", data: { url: QUOTE } });
});

test("removing an attachment the task doesn't have is not found", async () => {
  const r = await alex.call("DELETE", `/api/tasks/${taskId}/attachments/nope`);

  expect(r.status).toBe(404);
});

test("a stale revision can't attach over someone else's edit", async () => {
  const { task } = await alex.get(`/api/tasks/${taskId}`);
  await sam.patch(`/api/tasks/${taskId}`, { brief: "Two quotes so far" });

  const r = await alex.call("POST", `/api/tasks/${taskId}/attachments`, {
    url: QUOTE,
    expected_revision: task.revision,
  });

  expect(r.status).toBe(409);
});

test("attachments on a private task stay private", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Sam's present", visibility: "private" });
  await alex.post(`/api/tasks/${task.id}/attachments`, {
    url: "https://drive.google.com/file/d/ring/view",
    title: "Ring receipt",
  });

  const attach = await sam.call("POST", `/api/tasks/${task.id}/attachments`, { url: QUOTE });
  const list = await sam.get("/api/tasks");
  const feed = await sam.get("/api/changes");

  expect(attach.status).toBe(404);
  expect(JSON.stringify([list, feed])).not.toMatch(
    /Ring receipt|drive\.google\.com\/file\/d\/ring/,
  );
});

test("a read-only credential can't attach", async () => {
  const reader = new Api(server.url, await server.mintToken("alex", "viewer", "read"));

  const r = await reader.call("POST", `/api/tasks/${taskId}/attachments`, { url: QUOTE });

  expect(r.status).toBe(403);
});
