import { type Context, Hono } from "hono";
import { z } from "zod";
import type { App } from "../app.ts";
import { ForbiddenError, ValidationError } from "../domain/errors.ts";
import { ActorInput, ClaimInput, MomentInput, NOTE_KINDS } from "../domain/types.ts";
import type { AuthEnv } from "./auth.ts";

const HandoffInput = z
  .object({
    to: ActorInput,
    note: z.string().max(20_000).optional(),
    next_action: z.string().max(2000).optional(),
    brief: z.string().max(20_000).optional(),
    kind: z.enum(NOTE_KINDS).optional(),
    expected_revision: z.number().int().optional(),
    idempotency_key: z.string().max(200).optional(),
  })
  .strict();

const QueueSaveInput = z
  .object({
    name: z.string().max(200).optional(),
    visibility: z.enum(["household", "private"]).optional(),
    enabled: z.boolean().optional(),
    config: z.unknown().optional(),
    expected_revision: z.number().int().optional(),
    idempotency_key: z.string().max(200).optional(),
  })
  .strict();

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export function restApi(app: App): Hono<AuthEnv> {
  const { tasks, board, auth } = app;
  const api = new Hono<AuthEnv>();
  api.use("*", auth.middleware(true));

  api.get("/me", async (c) => {
    // Integrations verify a bearer token's effective identity here before opening MCP.
    c.header("Cache-Control", "no-store");
    const p = c.get("principal");
    const users = await tasks.users();
    return c.json({
      user: users.find((u) => u.id === p.userId) ?? null,
      agent: p.agent,
      can_write: p.canWrite,
      household: users.map((u) => ({ id: u.id, name: u.name })),
    });
  });

  api.get("/now", async (c) =>
    c.json(await board.now(c.get("principal"), { area: c.req.query("area") || null })),
  );
  api.post("/now/more", async (c) => {
    await board.showMore(c.get("principal"));
    return c.json(await board.now(c.get("principal")));
  });
  api.post("/now/enough", async (c) => {
    const { on } = z.object({ on: z.boolean().default(true) }).parse(await body(c));
    await board.enoughForNow(c.get("principal"), on);
    return c.json(await board.now(c.get("principal")));
  });

  api.post("/tasks", async (c) => {
    const t = await tasks.create(c.get("principal"), await body(c));
    return c.json(await board.view(c.get("principal"), t.id), 201);
  });

  api.get("/tasks", async (c) => {
    const p = c.get("principal");
    const q = c.req.query("q");
    const state = c.req.query("state");
    const states = state ? state.split(",") : undefined;
    const list = q
      ? await tasks.search(p, q, { includeClosed: state !== "active" })
      : await tasks.list(p, state === "active" ? ["open", "waiting"] : states);
    return c.json({ tasks: list });
  });

  api.get("/tasks/:id", async (c) => {
    const p = c.get("principal");
    const v = await board.view(p, c.req.param("id"));
    return c.json({ ...v, activity: await tasks.activity(p, v.task.id) });
  });

  const mutation =
    (fn: (id: string, input: unknown, c: Context<AuthEnv>) => Promise<{ id: string }>) =>
    async (c: Context<AuthEnv>) => {
      const t = await fn(c.req.param("id") as string, await body(c), c);
      return c.json(await board.view(c.get("principal"), t.id));
    };

  api.patch(
    "/tasks/:id",
    mutation((id, input, c) => tasks.update(c.get("principal"), id, input)),
  );
  api.post(
    "/tasks/:id/checkpoint",
    mutation((id, input, c) => tasks.checkpoint(c.get("principal"), id, input)),
  );
  api.post(
    "/tasks/:id/handoff",
    mutation((id, input, c) => {
      const h = HandoffInput.parse(input);
      return tasks.checkpoint(c.get("principal"), id, {
        note: h.note ?? "Handed off",
        kind: h.kind,
        next_actor: h.to,
        next_action: h.next_action,
        brief: h.brief,
        state: "open",
        expected_revision: h.expected_revision,
        idempotency_key: h.idempotency_key,
      });
    }),
  );
  api.post(
    "/tasks/:id/complete",
    mutation((id, input, c) => tasks.complete(c.get("principal"), id, input)),
  );
  api.post(
    "/tasks/:id/skip",
    mutation((id, input, c) => tasks.skip(c.get("principal"), id, input)),
  );
  api.post(
    "/tasks/:id/close",
    mutation((id, input, c) => tasks.close(c.get("principal"), id, input)),
  );
  api.post(
    "/tasks/:id/reopen",
    mutation((id, input, c) => tasks.reopen(c.get("principal"), id, input)),
  );
  api.post(
    "/tasks/:id/release",
    mutation((id, input, c) => {
      const { claim_id } = z.object({ claim_id: z.string().optional() }).parse(input);
      return tasks.releaseClaim(c.get("principal"), id, claim_id);
    }),
  );
  api.post(
    "/tasks/:id/snooze",
    mutation(async (id, input, c) => {
      const { until } = z.object({ until: MomentInput.nullable() }).strict().parse(input);
      await tasks.snooze(c.get("principal"), id, until);
      return { id };
    }),
  );
  api.post(
    "/tasks/:id/pin",
    mutation(async (id, input, c) => {
      const { pinned } = z.object({ pinned: z.boolean() }).strict().parse(input);
      await board.pin(c.get("principal"), id, pinned);
      return { id };
    }),
  );
  api.post(
    "/tasks/:id/attachments",
    mutation((id, input, c) => tasks.attach(c.get("principal"), id, input)),
  );
  api.delete("/tasks/:id/attachments/:attachmentId", async (c) => {
    const p = c.get("principal");
    const input = (await body(c)) as Record<string, unknown>;
    const t = await tasks.detach(p, c.req.param("id"), {
      ...input,
      attachment_id: c.req.param("attachmentId"),
    });
    return c.json(await board.view(p, t.id));
  });
  api.get("/tasks/:id/explain", async (c) =>
    c.json(
      await board.explain(c.get("principal"), c.req.param("id"), c.req.query("queue") || undefined),
    ),
  );
  api.get("/tasks/:id/membership", async (c) =>
    c.json({ membership: await board.membership(c.get("principal"), c.req.param("id")) }),
  );

  api.post("/claim", async (c) => {
    const p = c.get("principal");
    const t = await tasks.claim(p, ClaimInput.parse(await body(c)));
    return c.json(t ? await board.view(p, t.id) : { task: null });
  });

  api.get("/queues", async (c) => c.json({ queues: await board.listQueues(c.get("principal")) }));
  api.post("/queues", async (c) => {
    const input = QueueSaveInput.parse(await body(c));
    return c.json(await board.saveQueue(c.get("principal"), input), 201);
  });
  api.post("/queues/preview", async (c) => {
    const { config } = z.object({ config: z.unknown() }).parse(await body(c));
    return c.json(await board.previewQueue(c.get("principal"), config));
  });
  api.get("/queues/:id", async (c) =>
    c.json(await board.runQueue(c.get("principal"), c.req.param("id"))),
  );
  api.patch("/queues/:id", async (c) => {
    const input = QueueSaveInput.parse(await body(c));
    return c.json(await board.saveQueue(c.get("principal"), { ...input, id: c.req.param("id") }));
  });

  api.get("/changes", async (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(await board.changes(c.get("principal"), c.req.query("after"), limit));
  });

  api.get("/export", async (c) => {
    const p = c.get("principal");
    const all = await tasks.list(p);
    const withActivity = [];
    for (const t of all) withActivity.push({ task: t, activity: await tasks.activity(p, t.id) });
    return c.json({
      exported_at: app.clock.now().toISOString(),
      tasks: withActivity,
      queues: await board.listQueues(p),
    });
  });

  // Token management is for signed-in humans only: a token can't mint more tokens.
  api.get("/tokens", async (c) => {
    if (!c.get("viaSession")) throw new ForbiddenError("Manage tokens from the web app");
    return c.json({ tokens: await auth.listTokens(c.get("principal").userId as string) });
  });
  api.post("/tokens", async (c) => {
    if (!c.get("viaSession")) throw new ForbiddenError("Manage tokens from the web app");
    const input = z
      .object({
        kind: z.enum(["agent", "personal", "display"]).default("agent"),
        agent: z.string().optional(),
        scope: z.enum(["read", "write"]).default("write"),
        label: z.string().max(200).optional(),
      })
      .parse(await body(c));
    const userId = c.get("principal").userId as string;
    if (input.kind === "agent" && !input.agent) throw new ValidationError("agent is required");
    const issued = await auth.issueToken({
      issuedBy: userId,
      userId: input.kind === "display" ? null : userId,
      ...input,
    });
    return c.json(issued, 201);
  });
  api.delete("/tokens/:id", async (c) => {
    if (!c.get("viaSession")) throw new ForbiddenError("Manage tokens from the web app");
    await auth.revokeToken(c.get("principal").userId as string, c.req.param("id"));
    return c.json({ ok: true });
  });

  return api;
}
