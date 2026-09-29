import { afterEach, beforeEach, expect, test } from "vitest";
import { TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
let claude: Mcp;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  claude = await Mcp.connect(server.url, await server.mintToken("alex", "claude"));
});

afterEach(async () => {
  await claude.close();
  await server.stop();
});

test("an agent attaches a file link and another session finds it on the task", async () => {
  const { task } = await claude.call("create_task", { title: "Claim the dentist rebate" });

  await claude.call("attach_link", {
    task_id: task.id,
    url: "https://drive.google.com/file/d/receipt/view",
    title: "Dentist receipt",
  });

  const read = await claude.call("get_task", { task_id: task.id });
  expect(read.task.attachments).toEqual([
    expect.objectContaining({
      title: "Dentist receipt",
      added_by: { user: "alex", agent: "claude" },
    }),
  ]);
  expect(read.activity.at(-1)).toMatchObject({ kind: "attached", body: "Dentist receipt" });
});

test("an agent removes an attachment by its id", async () => {
  const { task } = await claude.call("create_task", { title: "Claim the dentist rebate" });
  const attached = await claude.call("attach_link", {
    task_id: task.id,
    url: "https://drive.google.com/file/d/receipt/view",
  });

  const after = await claude.call("remove_attachment", {
    task_id: task.id,
    attachment_id: attached.task.attachments[0].id,
  });

  expect(after.task.attachments).toBeUndefined();
});

test("a bad link comes back as an error the agent can read", async () => {
  const { task } = await claude.call("create_task", { title: "Claim the dentist rebate" });

  const r = await claude.raw("attach_link", { task_id: task.id, url: "file:///etc/passwd" });

  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toMatch(/http\(s\)/);
});
