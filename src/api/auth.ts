import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { Database } from "../db/db.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../domain/errors.ts";
import { newId } from "../domain/tasks.ts";
import type { Principal } from "../domain/types.ts";

export const SESSION_COOKIE = "tuit_session";
const OIDC_COOKIE = "tuit_oidc";
const SESSION_DAYS = 180;

/** A same-site path to return to after sign-in; anything else (including `//x`, `/\x`) is "/". */
export function safeNext(next: string | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (!next || !next.startsWith("/") || /[\\\u0000-\u001f\u007f\s]/.test(next)) return "/";
  const probe = new URL(next, "https://same.invalid");
  return probe.origin === "https://same.invalid" ? probe.pathname + probe.search + probe.hash : "/";
}

export type AuthEnv = { Variables: { principal: Principal; viaSession: boolean } };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface TokenInfo {
  id: string;
  kind: "agent" | "personal" | "display";
  agent: string | null;
  scope: "read" | "write";
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export class Auth {
  private oidcConfig: oidc.Configuration | null = null;
  private readonly db: Database;
  private readonly config: Config;
  private readonly clock: Clock;

  constructor(db: Database, config: Config, clock: Clock) {
    this.db = db;
    this.config = config;
    this.clock = clock;
  }

  private get secure(): boolean {
    return this.config.publicUrl.protocol === "https:";
  }

  private async oidcClient(): Promise<oidc.Configuration> {
    const o = this.config.oidc;
    if (!o) throw new NotFoundError("OIDC is not configured");
    if (!this.oidcConfig) {
      const url = new URL(o.issuer);
      this.oidcConfig = await oidc.discovery(
        url,
        o.clientId,
        o.clientSecret || undefined,
        undefined,
        url.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined,
      );
    }
    return this.oidcConfig;
  }

  async startLogin(c: Context, rawNext: string | undefined): Promise<Response> {
    const next = safeNext(rawNext);
    const config = await this.oidcClient();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    setCookie(c, OIDC_COOKIE, JSON.stringify({ verifier, state, next }), {
      httpOnly: true,
      secure: this.secure,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: new URL("/auth/callback", this.config.publicUrl).href,
      scope: "openid email profile",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
    });
    return c.redirect(url.href);
  }

  async finishLogin(c: Context): Promise<Response> {
    const config = await this.oidcClient();
    const raw = getCookie(c, OIDC_COOKIE);
    if (!raw) throw new ValidationError("Login session expired; try again");
    const { verifier, state, next } = JSON.parse(raw) as {
      verifier: string;
      state: string;
      next: string;
    };
    deleteCookie(c, OIDC_COOKIE, { path: "/" });
    const current = new URL(c.req.url);
    const callback = new URL(`/auth/callback${current.search}`, this.config.publicUrl);
    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: verifier,
      expectedState: state,
    });
    let claims: Record<string, unknown> | undefined = tokens.claims();
    if (claims && typeof claims.email !== "string") {
      // Some providers only release email via userinfo, not in the ID token.
      claims = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub as string);
    }
    const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : null;
    if (!email || (claims?.email_verified !== true && !this.config.oidcTrustUnverifiedEmail)) {
      throw new ForbiddenError("Your identity provider did not supply a verified email");
    }
    const user = this.config.users.find((u) => u.email === email);
    if (!user) throw new ForbiddenError(`${email} is not part of this household`);
    await this.startSession(c, user.id);
    return c.redirect(safeNext(next));
  }

  async startSession(c: Context, userId: string): Promise<void> {
    const secret = randomBytes(32).toString("base64url");
    const now = this.clock.now();
    await this.db.query(
      "INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [sha256(secret), userId, now, new Date(Date.now() + SESSION_DAYS * 86_400_000)],
    );
    setCookie(c, SESSION_COOKIE, secret, {
      httpOnly: true,
      secure: this.secure,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_DAYS * 86_400,
    });
  }

  async endSession(c: Context): Promise<void> {
    const secret = getCookie(c, SESSION_COOKIE);
    if (secret) await this.db.query("DELETE FROM sessions WHERE id_hash = $1", [sha256(secret)]);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }

  /** Resolve the caller from a bearer token or session cookie. Never from request content. */
  async principal(c: Context): Promise<{ principal: Principal; viaSession: boolean } | null> {
    const header = c.req.header("authorization");
    if (header?.toLowerCase().startsWith("bearer ")) {
      const r = await this.db.query(
        "UPDATE tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING *",
        [sha256(header.slice(7).trim())],
      );
      const t = r.rows[0];
      if (!t) return null;
      return {
        principal: {
          userId: t.user_id,
          agent: t.agent,
          canWrite: t.scope === "write",
          key: `token:${t.id}`,
        },
        viaSession: false,
      };
    }
    const secret = getCookie(c, SESSION_COOKIE);
    if (!secret) return null;
    const r = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM sessions WHERE id_hash = $1 AND expires_at > now()",
      [sha256(secret)],
    );
    const s = r.rows[0];
    if (!s) return null;
    return {
      principal: { userId: s.user_id, agent: null, canWrite: true, key: `user:${s.user_id}` },
      viaSession: true,
    };
  }

  /** Issue a token that acts for `userId` as `agent`, or a household display token. */
  async issueToken(input: {
    issuedBy: string | null;
    userId: string | null;
    kind: "agent" | "personal" | "display";
    agent?: string;
    scope?: "read" | "write";
    label?: string;
    expiresAt?: Date;
    oauthClientId?: string;
  }): Promise<{ token: string; info: TokenInfo }> {
    if (input.kind !== "display" && !input.userId) {
      throw new ValidationError("This token must act for a person");
    }
    if (input.kind === "agent") {
      if (!input.agent || !/^[a-zA-Z0-9_.-]{1,64}$/.test(input.agent)) {
        throw new ValidationError("Agent name must be letters, digits, '.', '_' or '-'");
      }
    }
    const secret = `tuit_${randomBytes(24).toString("base64url")}`;
    const id = newId();
    const scope = input.kind === "display" ? "read" : (input.scope ?? "write");
    const r = await this.db.query(
      `INSERT INTO tokens (id, token_hash, kind, user_id, agent, scope, label, issued_by, created_at, expires_at, oauth_client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        id,
        sha256(secret),
        input.kind,
        input.kind === "display" ? null : input.userId,
        input.kind === "agent" ? input.agent : null,
        scope,
        input.label ?? "",
        input.issuedBy,
        this.clock.now(),
        input.expiresAt ?? null,
        input.oauthClientId ?? null,
      ],
    );
    return { token: secret, info: tokenInfo(r.rows[0]) };
  }

  async listTokens(userId: string): Promise<TokenInfo[]> {
    const r = await this.db.query(
      "SELECT * FROM tokens WHERE issued_by = $1 AND revoked_at IS NULL ORDER BY created_at",
      [userId],
    );
    return r.rows.map(tokenInfo);
  }

  async revokeToken(userId: string, id: string): Promise<void> {
    const r = await this.db.query(
      "UPDATE tokens SET revoked_at = now() WHERE id = $1 AND issued_by = $2 AND revoked_at IS NULL",
      [id, userId],
    );
    if (r.rowCount !== 1) throw new NotFoundError(`No token ${id}`);
  }

  /** Session-authenticated state-changing requests must come from our own origin. */
  sameOrigin(c: Context): boolean {
    const origin = c.req.header("origin");
    if (origin) return origin === this.config.publicUrl.origin;
    const site = c.req.header("sec-fetch-site");
    return !site || site === "same-origin" || site === "none";
  }

  middleware(required: boolean): MiddlewareHandler<AuthEnv> {
    return async (c, next) => {
      const found = await this.principal(c);
      if (!found) {
        if (!required) return next();
        return c.json({ error: "unauthenticated", message: "Sign in or send a bearer token" }, 401);
      }
      if (
        found.viaSession &&
        c.req.method !== "GET" &&
        c.req.method !== "HEAD" &&
        !this.sameOrigin(c)
      ) {
        return c.json({ error: "forbidden", message: "Cross-origin request refused" }, 403);
      }
      c.set("principal", found.principal);
      c.set("viaSession", found.viaSession);
      return next();
    };
  }
}

// biome-ignore lint/suspicious/noExplicitAny: raw pg row
function tokenInfo(r: any): TokenInfo {
  return {
    id: r.id,
    kind: r.kind,
    agent: r.agent,
    scope: r.scope,
    label: r.label,
    created_at: r.created_at.toISOString(),
    last_used_at: r.last_used_at ? r.last_used_at.toISOString() : null,
  };
}
