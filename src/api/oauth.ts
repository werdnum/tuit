import { createHash, randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import type { App } from "../app.ts";
import { newId } from "../domain/tasks.ts";
import type { AuthEnv } from "./auth.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_S = 30 * 86_400;

type OAuthError = { error: string; error_description: string };

function oauthError(c: Context, error: string, description: string, status = 400): Response {
  return c.json({ error, error_description: description } satisfies OAuthError, status as 400);
}

function readOnlyRequested(scope: string | undefined): boolean {
  const scopes = (scope ?? "").split(" ");
  return scopes.includes("tasks:read") && !scopes.includes("tasks");
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "connector";
}

/**
 * A minimal OAuth 2.1 authorization server for remote MCP connectors: metadata discovery,
 * dynamic client registration, authorization code + PKCE (S256 only) and refresh tokens.
 * Consent requires the person's normal SSO session; the result is an agent token bound to them.
 */
export function oauthRoutes(app: App): Hono<AuthEnv> {
  const { db, config, auth } = app;
  const base = config.publicUrl.origin;
  const r = new Hono<AuthEnv>();

  r.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_name: "Household tasks",
    }),
  );
  r.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.redirect("/.well-known/oauth-protected-resource"),
  );

  r.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["tasks", "tasks:read"],
    }),
  );

  r.post("/oauth/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      client_name?: string;
      redirect_uris?: unknown;
    };
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u) => typeof u === "string")
      : [];
    if (uris.length === 0)
      return oauthError(c, "invalid_redirect_uri", "redirect_uris is required");
    for (const u of uris) {
      let url: URL;
      try {
        url = new URL(u);
      } catch {
        return oauthError(c, "invalid_redirect_uri", `Bad redirect URI ${u}`);
      }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        return oauthError(
          c,
          "invalid_redirect_uri",
          "Redirect URIs must be https (or http on loopback)",
        );
      }
    }
    const id = `c_${newId()}${newId()}`;
    const name = (body.client_name ?? "MCP connector").slice(0, 100);
    await db.query(
      "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ($1, $2, $3, now())",
      [id, name, uris],
    );
    return c.json(
      {
        client_id: id,
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  async function loadClient(id: string | undefined) {
    if (!id) return null;
    const res = await db.query<{ id: string; name: string; redirect_uris: string[] }>(
      "SELECT id, name, redirect_uris FROM oauth_clients WHERE id = $1",
      [id],
    );
    return res.rows[0] ?? null;
  }

  function consentPage(
    q: Record<string, string>,
    client: { name: string },
    user: string,
    redirectHost: string,
  ) {
    return html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <title>Connect ${client.name}</title>
          <style>
            body { font: 17px/1.45 -apple-system, system-ui, sans-serif; margin: 0; padding: max(24px, env(safe-area-inset-top)) 20px; max-width: 32rem; margin-inline: auto; }
            @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } input, select { background: #222; color: #eee; } }
            label { display: block; margin: 14px 0 6px; font-weight: 600; }
            input, select { font: inherit; width: 100%; padding: 10px; box-sizing: border-box; border-radius: 10px; border: 1px solid #8886; }
            .row { display: flex; gap: 12px; margin-top: 22px; }
            button { font: inherit; flex: 1; padding: 12px; border-radius: 12px; border: 0; min-height: 44px; }
            .allow { background: #2563eb; color: white; }
            .muted { color: #888; font-size: 15px; }
          </style>
        </head>
        <body>
          <h1>Connect ${client.name}?</h1>
          <p>
            <strong>${client.name}</strong> (returning to ${redirectHost}) wants to work with your tasks
            as an agent acting for <strong>${user}</strong>. It will see what you can see — household tasks
            and your private tasks — and nothing of anyone else's private tasks.
          </p>
          <form method="post" action="/oauth/authorize">
            ${Object.entries(q).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
            <label for="agent">Name it appears under</label>
            <input id="agent" name="agent" value="${slug(client.name)}" pattern="[a-zA-Z0-9_.\\-]{1,64}" required />
            <label for="access">Access</label>
            <select id="access" name="access">
              ${readOnlyRequested(q.scope) ? "" : html`<option value="write">Read and update tasks</option>`}
              <option value="read">Read only</option>
            </select>
            <p class="muted">You can revoke this at any time in Settings.</p>
            <div class="row">
              <button type="submit" name="decision" value="deny">Cancel</button>
              <button type="submit" name="decision" value="allow" class="allow">Allow</button>
            </div>
          </form>
        </body>
      </html>`;
  }

  function redirectWith(uri: string, params: Record<string, string | undefined>): string {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.href;
  }

  async function validateAuthorize(q: Record<string, string | undefined>) {
    const client = await loadClient(q.client_id);
    if (!client) return { fatal: "Unknown client_id" };
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      return { fatal: "redirect_uri is not registered for this client" };
    }
    if (q.response_type !== "code") return { client, error: "unsupported_response_type" };
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return { client, error: "invalid_request", description: "PKCE with S256 is required" };
    }
    if (q.resource && q.resource.replace(/\/$/, "") !== `${base}/mcp`) {
      return { client, error: "invalid_target", description: "Unknown resource" };
    }
    return { client };
  }

  r.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const v = await validateAuthorize(q);
    if (v.fatal) return c.text(v.fatal, 400);
    if (v.error) {
      return c.redirect(
        redirectWith(q.redirect_uri as string, {
          error: v.error,
          error_description: v.description,
          state: q.state,
        }),
      );
    }
    const found = await auth.principal(c);
    if (!found?.viaSession) {
      const next = `/oauth/authorize?${new URLSearchParams(q).toString()}`;
      return c.redirect(`/login?next=${encodeURIComponent(next)}`);
    }
    const users = await app.tasks.users();
    const name = users.find((u) => u.id === found.principal.userId)?.name ?? found.principal.userId;
    const keep = Object.fromEntries(
      [
        "client_id",
        "redirect_uri",
        "state",
        "code_challenge",
        "code_challenge_method",
        "resource",
        "scope",
        "response_type",
      ]
        .filter((k) => q[k] !== undefined)
        .map((k) => [k, q[k] as string]),
    );
    return c.html(
      consentPage(
        keep,
        v.client as { name: string },
        String(name),
        new URL(q.redirect_uri as string).host,
      ),
    );
  });

  r.post("/oauth/authorize", async (c) => {
    const found = await auth.principal(c);
    if (!found?.viaSession) return c.text("Sign in first", 401);
    if (!auth.sameOrigin(c)) return c.text("Cross-origin request refused", 403);
    const form = (await c.req.parseBody()) as Record<string, string>;
    const v = await validateAuthorize(form);
    if (v.fatal) return c.text(v.fatal, 400);
    if (v.error) {
      return c.redirect(
        redirectWith(form.redirect_uri as string, {
          error: v.error,
          error_description: v.description,
          state: form.state,
        }),
      );
    }
    if (form.decision !== "allow") {
      return c.redirect(
        redirectWith(form.redirect_uri as string, { error: "access_denied", state: form.state }),
      );
    }
    const agent =
      form.agent && /^[a-zA-Z0-9_.-]{1,64}$/.test(form.agent)
        ? form.agent
        : slug(v.client?.name ?? "");
    // The person may narrow access but never widen what the connector asked for.
    const scope = form.access === "read" || readOnlyRequested(form.scope) ? "read" : "write";
    const code = b64url(randomBytes(32));
    await db.query(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, agent, scope, redirect_uri, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sha256(code),
        form.client_id,
        found.principal.userId,
        agent,
        scope,
        form.redirect_uri,
        form.code_challenge,
        new Date(Date.now() + CODE_TTL_MS),
      ],
    );
    return c.redirect(redirectWith(form.redirect_uri as string, { code, state: form.state }));
  });

  async function issue(
    clientId: string,
    userId: string,
    agent: string,
    scope: "read" | "write",
    clientName: string,
  ) {
    const { token, info } = await auth.issueToken({
      issuedBy: userId,
      userId,
      kind: "agent",
      agent,
      scope,
      label: `${clientName} (connector)`,
      expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
      oauthClientId: clientId,
    });
    const refresh = b64url(randomBytes(32));
    await db.query(
      "INSERT INTO oauth_refresh (token_hash, client_id, access_token_id, created_at) VALUES ($1, $2, $3, now())",
      [sha256(refresh), clientId, info.id],
    );
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scope === "write" ? "tasks" : "tasks:read",
    };
  }

  r.post("/oauth/token", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>;
    const client = await loadClient(form.client_id);
    if (!client) return oauthError(c, "invalid_client", "Unknown client", 401);

    if (form.grant_type === "authorization_code") {
      const result = await db.tx(async (tx) => {
        const res = await tx.query(
          `UPDATE oauth_codes SET used_at = now()
           WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
          [sha256(form.code ?? "")],
        );
        return res.rows[0];
      });
      if (!result || result.client_id !== client.id)
        return oauthError(c, "invalid_grant", "Invalid or expired code");
      if (result.redirect_uri !== form.redirect_uri)
        return oauthError(c, "invalid_grant", "redirect_uri mismatch");
      const challenge = b64url(
        createHash("sha256")
          .update(form.code_verifier ?? "")
          .digest(),
      );
      if (challenge !== result.code_challenge)
        return oauthError(c, "invalid_grant", "PKCE verification failed");
      return c.json(
        await issue(client.id, result.user_id, result.agent, result.scope, client.name),
      );
    }

    if (form.grant_type === "refresh_token") {
      const row = await db.tx(async (tx) => {
        const res = await tx.query(
          `UPDATE oauth_refresh SET used_at = now()
           WHERE token_hash = $1 AND client_id = $2 AND used_at IS NULL RETURNING access_token_id`,
          [sha256(form.refresh_token ?? ""), client.id],
        );
        const old = res.rows[0];
        if (!old) return null;
        const tok = await tx.query(
          "UPDATE tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id, agent, scope",
          [old.access_token_id],
        );
        return tok.rows[0] ?? null;
      });
      // Revoking the access token in Settings also kills its refresh token.
      if (!row) return oauthError(c, "invalid_grant", "Invalid refresh token");
      return c.json(await issue(client.id, row.user_id, row.agent, row.scope, client.name));
    }

    return oauthError(c, "unsupported_grant_type", "Use authorization_code or refresh_token");
  });

  return r;
}
