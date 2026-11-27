import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";

let server: TestServer;
let alex: Api;
let sam: Api;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T14:00:00+11:00");
  alex = await server.human("alex");
  sam = await server.human("sam");
});

afterEach(async () => {
  await server.stop();
});

async function add(api: Api, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await api.post("/api/tasks", { title, ...extra })).task.id;
}

describe("external_keys", () => {
  test("create, query by external_key, patch update and delete without clobbering siblings", async () => {
    const id = await add(alex, "[warning] KubeJobFailed (lake-system)", {
      area: "alerts",
      external_keys: { "alert:KubeJobFailed,lake-system": "fp1" },
    });

    const found = await alex.get(
      "/api/tasks?state=active&area=alerts&external_key=alert:KubeJobFailed,lake-system",
    );
    expect(found.tasks.map((t: { id: string }) => t.id)).toEqual([id]);

    // Patch adds a second key without touching the first.
    await alex.patch(`/api/tasks/${id}`, {
      external_keys: { "alert:SimpleFINSyncFailed,lake-system": "fp2" },
    });
    let task = (await alex.get(`/api/tasks/${id}`)).task;
    expect(task.external_keys).toEqual({
      "alert:KubeJobFailed,lake-system": "fp1",
      "alert:SimpleFINSyncFailed,lake-system": "fp2",
    });

    // Checkpoint updates one key and removes another via null.
    await alex.post(`/api/tasks/${id}/checkpoint`, {
      note: "KubeJobFailed resolved; SimpleFINSyncFailed updated",
      external_keys: {
        "alert:KubeJobFailed,lake-system": null,
        "alert:SimpleFINSyncFailed,lake-system": "fp2,fp3",
      },
    });
    task = (await alex.get(`/api/tasks/${id}`)).task;
    expect(task.external_keys).toEqual({
      "alert:SimpleFINSyncFailed,lake-system": "fp2,fp3",
    });

    const gone = await alex.get(
      "/api/tasks?state=active&area=alerts&external_key=alert:KubeJobFailed,lake-system",
    );
    expect(gone.tasks).toEqual([]);
  });
});

describe("merge", () => {
  test("merges a duplicate into a surviving task, unioning external_keys without hijacking actor/claim/attachments", async () => {
    const agent = await server.api("alex", "k8s-agent");
    const canonical = await add(agent, "[warning] KubeJobFailed (lake-system)", {
      area: "alerts",
      next_actor: "alex",
      external_keys: { "alert:KubeJobFailed,lake-system": "fp1", shared: "keep-target" },
    });
    await agent.post(`/api/tasks/${canonical}/attachments`, {
      url: "https://omnigent.example/c/1111111111111111",
      title: "Omnigent session",
    });

    const dup = await add(agent, "[warning] SimpleFINSyncFailed (lake-system)", {
      area: "alerts",
      next_actor: "agent:k8s-agent",
      external_keys: { "alert:SimpleFINSyncFailed,lake-system": "fp2", shared: "from-source" },
    });
    const claimed = await agent.post("/api/claim", { task_id: dup });
    const claimId = claimed.task.claim.id as string;
    await agent.post(`/api/tasks/${dup}/attachments`, {
      url: "https://omnigent.example/c/2222222222222222",
      title: "Omnigent session",
      claim_id: claimId,
    });

    const { cursor } = await alex.get("/api/changes?after=latest");
    const merged = await agent.post(`/api/tasks/${dup}/merge`, {
      into: canonical,
      note: "Same Morgan Stanley SimpleFIN re-auth root cause.",
      claim_id: claimId,
    });

    expect(merged.task.id).toBe(dup);
    expect(merged.task.state).toBe("expired");
    expect(merged.task.merged_into).toBe(canonical);
    expect(merged.task.claim).toBeNull();
    expect(merged.merged_into.task.id).toBe(canonical);
    expect(merged.merged_into.task.external_keys).toEqual({
      "alert:KubeJobFailed,lake-system": "fp1",
      "alert:SimpleFINSyncFailed,lake-system": "fp2",
      shared: "keep-target",
    });

    // Target keeps its actor and its own Omnigent session attachment only.
    const targetView = await alex.get(`/api/tasks/${canonical}`);
    expect(targetView.task.next_actor).toEqual({ kind: "user", user: "alex" });
    expect(targetView.task.attachments.map((a: { url: string }) => a.url)).toEqual([
      "https://omnigent.example/c/1111111111111111",
    ]);
    expect(targetView.merged_from.map((m: { id: string }) => m.id)).toEqual([dup]);
    expect(targetView.activity.at(-1).body).toContain(dup);
    expect(targetView.activity.at(-1).body).toContain("Morgan Stanley SimpleFIN");

    const sourceView = await alex.get(`/api/tasks/${dup}`);
    expect(sourceView.merged_into_task).toMatchObject({ id: canonical });

    // No handed_off event on target (so Alex doesn't get a duplicate handoff notification).
    const feed = await alex.get(`/api/changes?after=${cursor}`);
    expect(feed.events.filter((e: { type: string }) => e.type === "handed_off")).toEqual([]);
    expect(
      feed.events.some(
        (e: { type: string; task?: { id: string }; data?: { merged_from?: string } }) =>
          e.type === "checkpoint" && e.task?.id === canonical && e.data?.merged_from === dup,
      ),
    ).toBe(true);

    // Repeating the same merge is idempotent.
    const again = await agent.post(`/api/tasks/${dup}/merge`, { into: canonical });
    expect(again.task.merged_into).toBe(canonical);

    // Reopening clears merged_into.
    await alex.post(`/api/tasks/${dup}/reopen`, {});
    expect((await alex.get(`/api/tasks/${dup}`)).task.merged_into).toBeNull();
  });

  test("re-points tasks waiting on the merged source to the target", async () => {
    const canonical = await add(alex, "Canonical incident");
    const dup = await add(alex, "Duplicate incident");
    const waiter = await add(alex, "Follow-up check");
    await alex.post(`/api/tasks/${waiter}/checkpoint`, {
      note: "Waiting on duplicate",
      waiting: { kind: "task", task_id: dup },
    });

    await alex.post(`/api/tasks/${dup}/merge`, { into: canonical });

    const w = (await alex.get(`/api/tasks/${waiter}`)).task;
    expect(w.state).toBe("waiting");
    expect(w.waiting.task_id).toBe(canonical);
  });

  test("enforces validation and privacy boundaries", async () => {
    const a = await add(alex, "Public task");
    const priv = await add(alex, "Private secret", { visibility: "private" });
    const parent = await add(alex, "Parent with part");
    await add(alex, "Open part", { parent_id: parent });
    const closed = await add(alex, "Already done");
    await alex.post(`/api/tasks/${closed}/complete`, {});

    // Self-merge refused.
    expect((await alex.call("POST", `/api/tasks/${a}/merge`, { into: a })).status).toBe(400);
    // Closed target refused.
    expect((await alex.call("POST", `/api/tasks/${a}/merge`, { into: closed })).status).toBe(400);
    // Source with open parts refused.
    expect((await alex.call("POST", `/api/tasks/${parent}/merge`, { into: a })).status).toBe(400);
    // Private source -> household target refused.
    expect((await alex.call("POST", `/api/tasks/${priv}/merge`, { into: a })).status).toBe(400);

    // Household source -> private target hides private target title from Sam.
    await alex.post(`/api/tasks/${a}/merge`, { into: priv });
    const seenBySam = await sam.get(`/api/tasks/${a}`);
    expect(seenBySam.merged_into_task).toBeNull();
    expect(seenBySam.task.close_reason).toBe("Merged into another task");
    expect(JSON.stringify(seenBySam)).not.toContain("Private secret");
  });
});
