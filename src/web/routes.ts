import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ZodError, z } from "zod";
import { type AuthEnv, safeNext } from "../api/auth.ts";
import type { App } from "../app.ts";
import { ConflictError, DomainError, NotFoundError, ValidationError } from "../domain/errors.ts";
import type { Principal, Task } from "../domain/types.ts";
import type { Explanation } from "../domain/views.ts";
import { actorText, momentEditText, whenText } from "./format.ts";
import { type Flash, MANIFEST } from "./layout.ts";
import { liveStream } from "./live.ts";
import {
  type Ctx,
  DEFAULT_QUEUE_CONFIG,
  detailPage,
  devLoginPage,
  errorPage,
  inspectPage,
  nowPage,
  queuePage,
  queuesPage,
  searchPage,
  settingsPage,
  viewPage,
} from "./pages.ts";

const FLASH_COOKIE = "tuit_flash";

/** What the Drive picker hands back for the files someone chose or uploaded. */
const PickedFiles = z
  .array(
    z.object({ url: z.string(), title: z.string().optional(), mime_type: z.string().optional() }),
  )
  .min(1)
  .max(20);
type Form = Record<string, string>;
type WebContext = Context<AuthEnv>;

const STATIC_DIR = join(import.meta.dirname, "static");
const STATIC_FILES: Record<string, string> = {
  "icon.svg": "image/svg+xml",
  "apple-touch-icon.png": "image/png",
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
};

/** Where a form post returns to: a same-site path (per safeNext), otherwise the fallback. */
function safePath(v: string | undefined, fallback: string): string {
  return v && safeNext(v) === v ? v : fallback;
}

async function formOf(c: WebContext): Promise<Form> {
  const raw = await c.req.parseBody();
  const out: Form = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

function revision(form: Form): number | undefined {
  const n = Number(form.expected_revision);
  return form.expected_revision && Number.isInteger(n) ? n : undefined;
}

function flash(c: WebContext, text: string, kind: Flash["kind"] = "info"): void {
  setCookie(c, FLASH_COOKIE, encodeURIComponent(JSON.stringify({ text, kind })), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 60,
  });
}

function takeFlash(c: WebContext): Flash | null {
  const v = getCookie(c, FLASH_COOKIE);
  if (!v) return null;
  deleteCookie(c, FLASH_COOKIE, { path: "/" });
  try {
    return JSON.parse(decodeURIComponent(v)) as Flash;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string | null {
  if (err instanceof DomainError) return err.message;
  if (err instanceof ZodError) return err.issues.map((i) => i.message).join("; ");
  return null;
}

const splitList = (s: string | undefined) =>
  (s ?? "")
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function webRoutes(app: App): Hono<AuthEnv> {
  const { tasks, board, auth } = app;
  const r = new Hono<AuthEnv>();

  async function ctxFor(c: WebContext, me: Principal): Promise<Ctx> {
    return {
      me,
      users: await tasks.users(),
      now: app.clock.now(),
      flash: takeFlash(c),
      // After the sweep (board.changes runs it), so time-driven events it writes are counted.
      live: { cursor: (await board.changes(me, "latest")).cursor, at: Date.now() },
    };
  }

  /** Web pages are for signed-in humans: a session cookie, never a bearer token. */
  async function sessionPrincipal(c: WebContext): Promise<Principal | null> {
    const found = await auth.principal(c);
    return found?.viaSession ? found.principal : null;
  }

  function loginRedirect(c: WebContext): Response {
    const url = new URL(c.req.url);
    const next = c.req.method === "GET" ? url.pathname + url.search : "/";
    return c.redirect(`/login?next=${encodeURIComponent(next)}`, 303);
  }

  const view =
    (handler: (c: WebContext, ctx: Ctx) => Promise<Response>) =>
    async (c: WebContext): Promise<Response> => {
      const me = await sessionPrincipal(c);
      if (!me) return loginRedirect(c);
      c.set("principal", me);
      return handler(c, await ctxFor(c, me));
    };

  /**
   * A form post: run it, then redirect back (303). A rejected action comes back as a
   * message on the page it came from.
   */
  const action =
    (
      handler: (c: WebContext, p: Principal, form: Form) => Promise<string | Response | undefined>,
      fallback = "/",
    ) =>
    async (c: WebContext): Promise<Response> => {
      const me = await sessionPrincipal(c);
      if (!me) return loginRedirect(c);
      if (!auth.sameOrigin(c)) return c.text("Cross-origin request refused", 403);
      c.set("principal", me);
      const form = await formOf(c);
      const backTo = safePath(form.back, fallback);
      try {
        const out = await handler(c, me, form);
        if (out instanceof Response) return out;
        return c.redirect(safePath(out, backTo), 303);
      } catch (err) {
        const msg = errorMessage(err);
        if (msg === null || err instanceof NotFoundError) throw err;
        flash(c, msg, "error");
        return c.redirect(backTo, 303);
      }
    };

  r.onError(async (err, c) => {
    const me = await sessionPrincipal(c).catch(() => null);
    const ctx = me ? await ctxFor(c, me).catch(() => null) : null;
    if (err instanceof NotFoundError) {
      return c.html(
        errorPage(
          ctx,
          "Not found",
          "There's nothing here. It may have been a link to something you can't see.",
        ),
        404,
      );
    }
    const msg = errorMessage(err);
    if (msg !== null) {
      const status = err instanceof DomainError ? err.status : 400;
      return c.html(errorPage(ctx, "That didn't work", msg), status as 400);
    }
    console.error(err);
    return c.html(errorPage(ctx, "Something went wrong", "Try again in a moment."), 500);
  });

  // ---- Sign-in (behaviour kept from the original stub)

  r.get("/login", async (c) => {
    const next = safeNext(c.req.query("next"));
    if (app.config.oidc) return auth.startLogin(c, next);
    return c.html(devLoginPage(app.config.users, next));
  });
  r.post("/login/dev", async (c) => {
    if (!app.config.devLogin) return c.text("Not found", 404);
    if (!auth.sameOrigin(c)) return c.text("Cross-origin request refused", 403);
    const form = await formOf(c);
    const user = app.config.users.find((u) => u.id === form.user);
    if (!user) return c.text("Unknown user", 400);
    await auth.startSession(c, user.id);
    return c.redirect(safeNext(form.next), 303);
  });
  r.get("/auth/callback", (c) => auth.finishLogin(c));
  r.post("/logout", async (c) => {
    if (!auth.sameOrigin(c)) return c.text("Cross-origin request refused", 403);
    await auth.endSession(c);
    return c.redirect("/login", 303);
  });

  // ---- Live updates

  r.get("/live", async (c) => {
    const me = await sessionPrincipal(c);
    if (!me) return c.text("Sign in", 401);
    return liveStream(c, app.db, app.live, me);
  });

  // ---- Static assets

  r.get("/manifest.webmanifest", (c) => {
    c.header("content-type", "application/manifest+json");
    return c.body(JSON.stringify(MANIFEST));
  });
  const staticCache = new Map<string, Buffer>();
  r.get("/static/:name", (c) => {
    const name = c.req.param("name");
    const type = STATIC_FILES[name];
    if (!type) return c.text("Not found", 404);
    let buf = staticCache.get(name);
    if (!buf) {
      buf = readFileSync(join(STATIC_DIR, name));
      staticCache.set(name, buf);
    }
    c.header("content-type", type);
    c.header("cache-control", "public, max-age=86400");
    return c.body(new Uint8Array(buf));
  });

  // ---- Now

  r.get(
    "/",
    view(async (c, ctx) => c.html(nowPage(ctx, await board.now(ctx.me)))),
  );
  r.post(
    "/capture",
    action(async (_c, p, form) => {
      const title = (form.title ?? "").trim();
      if (!title) throw new ValidationError("Type something to capture");
      await tasks.create(p, { title });
      return "/";
    }),
  );
  r.post(
    "/now/more",
    action(async (_c, p) => {
      await board.showMore(p);
      return "/";
    }),
  );
  r.post(
    "/now/enough",
    action(async (_c, p, form) => {
      await board.enoughForNow(p, form.on !== "0");
      return "/";
    }),
  );

  // ---- Task detail

  async function renderDetail(
    c: WebContext,
    ctx: Ctx,
    id: string,
    opts: { conflictMine?: string } = {},
  ): Promise<Response> {
    const v = await board.view(ctx.me, id);
    const activity = await tasks.activity(ctx.me, id);
    const html = detailPage(ctx, {
      ...v,
      activity,
      showAll: c.req.query("all") === "1",
      picker: app.config.googlePicker,
      conflict: opts.conflictMine !== undefined ? { mine: opts.conflictMine } : undefined,
    });
    return c.html(html, opts.conflictMine !== undefined ? 409 : 200);
  }

  r.get(
    "/tasks/:id",
    view((c, ctx) => renderDetail(c, ctx, c.req.param("id") as string)),
  );

  r.get(
    "/tasks/:id/inspect",
    view(async (c, ctx) => {
      const id = c.req.param("id") as string;
      const v = await board.view(ctx.me, id);
      return c.html(
        inspectPage(ctx, {
          ...v,
          attention: await tasks.attention(ctx.me, id),
          activity: await tasks.activity(ctx.me, id),
          membership: await board.membership(ctx.me, id),
        }),
      );
    }),
  );

  const taskAction = (
    handler: (p: Principal, id: string, form: Form) => Promise<unknown>,
  ): ((c: WebContext) => Promise<Response>) =>
    action(async (c, p, form) => {
      const id = c.req.param("id") as string;
      await handler(p, id, form);
      return undefined;
    });

  r.post(
    "/tasks/:id/done",
    taskAction((p, id, form) =>
      tasks.complete(p, id, form.at ? { at: form.at, note: form.note || undefined } : {}),
    ),
  );
  r.post(
    "/tasks/:id/skip",
    taskAction((p, id) => tasks.skip(p, id, {})),
  );
  r.post(
    "/tasks/:id/note",
    taskAction((p, id, form) => tasks.checkpoint(p, id, { note: form.note ?? "" })),
  );
  r.post(
    "/tasks/:id/waiting",
    taskAction((p, id, form) => {
      const what = (form.for ?? "").trim();
      return tasks.checkpoint(p, id, {
        note: what ? `Waiting for ${what}` : "Waiting",
        waiting: { kind: "reply", for: what, follow_up: form.follow_up?.trim() || undefined },
        expected_revision: revision(form),
      });
    }),
  );
  r.post(
    "/tasks/:id/resume",
    taskAction((p, id, form) =>
      tasks.checkpoint(p, id, {
        note: form.note?.trim() || "No longer waiting",
        state: "open",
        expected_revision: revision(form),
      }),
    ),
  );
  r.post(
    "/tasks/:id/snooze",
    taskAction((p, id, form) => tasks.snooze(p, id, form.until?.trim() || null)),
  );
  r.post(
    "/tasks/:id/handoff",
    taskAction((p, id, form) => {
      let to = form.to ?? "";
      if (to === "agent") {
        const agent = (form.agent ?? "").trim();
        if (!agent) throw new ValidationError("Which agent? Type its name.");
        to = `agent:${agent}`;
      }
      const note = (form.note ?? "").trim();
      return tasks.checkpoint(p, id, {
        note: note || "Handed off",
        kind: "note",
        next_actor: to,
        next_action: form.next_action !== undefined ? form.next_action.trim() : undefined,
        state: "open",
        expected_revision: revision(form),
      });
    }),
  );
  r.post(
    "/tasks/:id/close",
    taskAction((p, id, form) =>
      tasks.close(p, id, {
        state: form.state === "shelved" ? "shelved" : "expired",
        reason: form.reason?.trim() || undefined,
        expected_revision: revision(form),
      }),
    ),
  );
  r.post(
    "/tasks/:id/reopen",
    taskAction((p, id, form) => tasks.reopen(p, id, { expected_revision: revision(form) })),
  );

  r.post(
    "/tasks/:id/attachments",
    taskAction((p, id, form) =>
      tasks.attach(p, id, { url: form.url ?? "", title: form.title?.trim() || undefined }),
    ),
  );
  r.post(
    "/tasks/:id/attachments/drive",
    taskAction(async (p, id, form) => {
      let items: z.infer<typeof PickedFiles>;
      try {
        items = PickedFiles.parse(JSON.parse(form.items ?? ""));
      } catch {
        throw new ValidationError("Google Drive sent something unexpected. Try again.");
      }
      for (const item of items) await tasks.attach(p, id, item);
    }),
  );
  r.post(
    "/tasks/:id/attachments/remove",
    taskAction((p, id, form) => tasks.detach(p, id, { attachment_id: form.attachment_id ?? "" })),
  );

  // A brief edit that loses a race re-renders with both versions, so the edit isn't lost.
  r.post("/tasks/:id/brief", async (c) => {
    const me = await sessionPrincipal(c);
    if (!me) return loginRedirect(c);
    if (!auth.sameOrigin(c)) return c.text("Cross-origin request refused", 403);
    const id = c.req.param("id");
    const form = await formOf(c);
    const brief = (form.brief ?? "").replace(/\r\n/g, "\n");
    try {
      await tasks.update(me, id, { brief, expected_revision: revision(form) });
    } catch (err) {
      if (err instanceof ConflictError) {
        return renderDetail(c, await ctxFor(c, me), id, { conflictMine: brief });
      }
      throw err;
    }
    return c.redirect(`/tasks/${id}`, 303);
  });

  r.post(
    "/tasks/:id/edit",
    taskAction((p, id, form) =>
      tasks.update(p, id, {
        title: form.title,
        next_action: form.next_action ?? "",
        done_means: form.done_means ?? "",
        expected_revision: revision(form),
      }),
    ),
  );

  r.post(
    "/tasks/:id/dates",
    taskAction(async (p, id, form) => {
      const t = await tasks.get(p, id);
      const input: Record<string, unknown> = { expected_revision: revision(form) };
      for (const k of ["available_from", "target", "deadline", "expires"] as const) {
        const v = (form[k] ?? "").trim();
        // Unchanged text is left alone, so a derived date keeps its rule.
        if (v === momentEditText(t[k])) continue;
        input[k] = v === "" ? null : v;
      }
      return tasks.update(p, id, input);
    }),
  );
  r.post(
    "/tasks/:id/visibility",
    taskAction((p, id, form) =>
      tasks.update(p, id, {
        visibility: form.private ? "private" : "household",
        expected_revision: revision(form),
      }),
    ),
  );
  r.post(
    "/tasks/:id/contexts",
    taskAction((p, id, form) =>
      tasks.update(p, id, {
        requires: splitList(form.requires),
        prefers: splitList(form.prefers),
        expected_revision: revision(form),
      }),
    ),
  );
  r.post(
    "/tasks/:id/routine",
    taskAction((p, id, form) => {
      const mode = form.mode;
      const every = Number(form.every_days);
      if (mode !== "after_completion" && mode !== "since_done") {
        return tasks.update(p, id, { recurrence: null, expected_revision: revision(form) });
      }
      if (!Number.isInteger(every) || every < 1) {
        throw new ValidationError("How many days? Use a whole number.");
      }
      return tasks.update(p, id, {
        recurrence: { mode, every_days: every },
        expected_revision: revision(form),
      });
    }),
  );

  // ---- Queues

  r.get(
    "/queues",
    view(async (c, ctx) => c.html(queuesPage(ctx, await board.listQueues(ctx.me)))),
  );

  r.post("/queues", async (c) => {
    const me = await sessionPrincipal(c);
    if (!me) return loginRedirect(c);
    if (!auth.sameOrigin(c)) return c.text("Cross-origin request refused", 403);
    const form = await formOf(c);
    try {
      const q = await board.saveQueue(me, {
        name: form.name ?? "",
        visibility: form.visibility === "private" ? "private" : "household",
        config: parseJson(form.config ?? ""),
      });
      return c.redirect(`/queues/${q.id}`, 303);
    } catch (err) {
      const msg = errorMessage(err);
      if (msg === null) throw err;
      const ctx = await ctxFor(c, me);
      return c.html(
        queuesPage(ctx, await board.listQueues(me), {
          name: form.name ?? "",
          config: form.config ?? DEFAULT_QUEUE_CONFIG,
          visibility: form.visibility ?? "household",
          error: msg,
        }),
        400,
      );
    }
  });

  r.get(
    "/queues/waiting",
    view(async (c, ctx) => {
      const me = ctx.me.userId;
      const result = await board.previewQueue(ctx.me, {
        actor: "all",
        include_waiting: true,
        include_resting: true,
        visible_limit: 200,
      });
      const items = [...result.items, ...result.urgent].filter(
        (i) =>
          i.task.state === "waiting" &&
          ((i.task.next_actor.kind === "user" && i.task.next_actor.user === me) ||
            i.task.owner === me),
      );
      return c.html(
        viewPage(ctx, {
          title: "Waiting",
          blurb:
            "Things waiting on a reply, a date or another task, where it's your turn or yours overall.",
          items: items.map((i) => ({ task: i.task, why: i.label || i.why })),
        }),
      );
    }),
  );
  r.get(
    "/queues/open",
    view(async (c, ctx) => {
      const result = await board.previewQueue(ctx.me, {
        actor: "all",
        include_waiting: true,
        include_resting: true,
        visible_limit: 200,
        order: ["urgency", "target", "oldest"],
      });
      return c.html(
        viewPage(ctx, {
          title: "Everything open",
          blurb: "Every open or waiting task you can see, whoever's turn it is.",
          items: [...result.urgent, ...result.items].map((i) => ({
            task: i.task,
            why: [i.label, `next: ${actorText(i.task.next_actor, ctx.users, ctx.me)}`]
              .filter(Boolean)
              .join(" · "),
          })),
          badge: true,
        }),
      );
    }),
  );
  r.get(
    "/queues/closed",
    view(async (c, ctx) => {
      const closed = await tasks.list(ctx.me, ["done", "expired", "shelved"]);
      closed.sort((a, b) =>
        (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at),
      );
      return c.html(
        viewPage(ctx, {
          title: "Recently closed",
          blurb: "Done, expired and shelved. Nothing is deleted; notes are kept.",
          items: closed.slice(0, 100).map((t) => ({
            task: t,
            why: [t.closed_at ? whenText(t.closed_at, ctx.now) : "", t.close_reason]
              .filter(Boolean)
              .join(" · "),
          })),
          badge: true,
        }),
      );
    }),
  );

  async function explainFor(
    p: Principal,
    queueId: string,
    query: string,
  ): Promise<{ task: Task; explanation: Explanation }[]> {
    let candidates: Task[] = [];
    try {
      candidates = [await tasks.get(p, query)];
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      candidates = await tasks.search(p, query, { limit: 5 });
    }
    const out: { task: Task; explanation: Explanation }[] = [];
    for (const t of candidates) {
      out.push({ task: t, explanation: await board.explain(p, t.id, queueId) });
    }
    return out;
  }

  r.get(
    "/queues/:id",
    view(async (c, ctx) => {
      const id = c.req.param("id") as string;
      const { queue, result } = await board.runQueue(ctx.me, id);
      const why = c.req.query("why")?.trim();
      return c.html(
        queuePage(ctx, {
          queue,
          result,
          explain: why ? { query: why, results: await explainFor(ctx.me, id, why) } : undefined,
        }),
      );
    }),
  );

  r.post("/queues/:id", async (c) => {
    const me = await sessionPrincipal(c);
    if (!me) return loginRedirect(c);
    if (!auth.sameOrigin(c)) return c.text("Cross-origin request refused", 403);
    const id = c.req.param("id");
    const form = await formOf(c);
    const formState = {
      name: form.name ?? "",
      config: form.config ?? "",
      visibility: form.visibility ?? "household",
      enabled: !!form.enabled,
    };
    try {
      const config = parseJson(form.config ?? "");
      if (form.op === "preview") {
        const { queue, result } = await board.runQueue(me, id);
        const preview = await board.previewQueue(me, config);
        return c.html(queuePage(await ctxFor(c, me), { queue, result, preview, form: formState }));
      }
      await board.saveQueue(me, {
        id,
        name: formState.name,
        visibility:
          form.visibility === "private" ? "private" : form.visibility ? "household" : undefined,
        enabled: formState.enabled,
        config,
        expected_revision: revision(form),
      });
      flash(c, "Queue saved");
      return c.redirect(`/queues/${id}`, 303);
    } catch (err) {
      const msg =
        err instanceof ConflictError
          ? "Someone changed this queue while you were editing. Your edit is below; the saved config is shown above."
          : errorMessage(err);
      if (msg === null || err instanceof NotFoundError) throw err;
      const { queue, result } = await board.runQueue(me, id);
      return c.html(
        queuePage(await ctxFor(c, me), { queue, result, form: formState, error: msg }),
        400,
      );
    }
  });

  // ---- Search

  r.get(
    "/search",
    view(async (c, ctx) => {
      const q = (c.req.query("q") ?? "").trim();
      const results = q ? await tasks.search(ctx.me, q, { includeClosed: true }) : null;
      return c.html(searchPage(ctx, q, results));
    }),
  );

  // ---- Settings

  r.get(
    "/settings",
    view(async (c, ctx) =>
      c.html(settingsPage(ctx, await auth.listTokens(ctx.me.userId as string))),
    ),
  );
  r.post(
    "/settings/tokens",
    action(async (c, p, form) => {
      const userId = p.userId as string;
      const kind =
        form.kind === "display" ? "display" : form.kind === "personal" ? "personal" : "agent";
      const issued = await auth.issueToken({
        issuedBy: userId,
        userId: kind === "display" ? null : userId,
        kind,
        agent: kind === "agent" ? (form.agent ?? "").trim() : undefined,
        scope: form.scope === "read" ? "read" : "write",
        label: form.label?.trim() || undefined,
      });
      // Rendered directly rather than redirected: the secret is shown exactly once.
      const ctx = await ctxFor(c, p);
      c.header("cache-control", "no-store");
      return c.html(settingsPage(ctx, await auth.listTokens(userId), issued));
    }, "/settings"),
  );
  r.post(
    "/settings/tokens/:id/revoke",
    action(async (c, p) => {
      await auth.revokeToken(p.userId as string, c.req.param("id") as string);
      flash(c, "Token revoked");
      return "/settings";
    }, "/settings"),
  );

  return r;
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`Config isn't valid JSON: ${(err as Error).message}`);
  }
}
