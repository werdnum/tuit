import { z } from "zod";
import type { ApnsConfig } from "./notify/channels.ts";

export interface HouseholdUser {
  id: string;
  email: string;
  name: string;
}

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  publicUrl: URL;
  users: HouseholdUser[];
  oidc: { issuer: string; clientId: string; clientSecret: string } | null;
  /**
   * Accept access tokens from an external authorization server (e.g. Keycloak) on /mcp, for
   * remote MCP connectors. When set, the built-in OAuth server is switched off and the
   * protected-resource metadata points connectors at this issuer instead.
   */
  mcpJwt: {
    issuer: string;
    /** Any of these audiences is accepted: tuit-mcp for connectors, tuit-api for the app. */
    audiences: string[];
    jwksUri: string | null;
    /**
     * Clients whose tokens act as the person themself rather than as an agent, e.g. the
     * iPhone app (tuit-ios). Everything else from the issuer is an agent named after its client.
     */
    personalClients: string[];
  } | null;
  /**
   * "<Team ID>.<bundle id>" of native iPhone apps allowed to receive the sign-in callback, e.g.
   * "H7NBC2S52X.dev.andrewgarrett.tuit". Served in apple-app-site-association.
   */
  iosAppIds: string[];
  /** Accept an email the provider doesn't mark verified. Off unless the IdP controls emails. */
  oidcTrustUnverifiedEmail: boolean;
  /** Pick-a-user login with no identity provider. Only honoured for a localhost public URL. */
  devLogin: boolean;
  /** Expose POST /__test/clock so the whole stack can be driven through time. */
  testClock: boolean;
  sweepIntervalMs: number;
  /**
   * Webhook delivery for the MCP Events extension. Receivers must be public HTTPS endpoints
   * unless `allowPrivateNetworks` is set (local development, or a receiver inside the cluster),
   * which also allows plain http. A failed delivery is retried after each delay in turn, then
   * given up on.
   */
  webhooks: { allowPrivateNetworks: boolean; retryDelaysMs: number[] };
  /**
   * Claude Code scheduled tasks (routines) to start when work is waiting for an agent. Each
   * watches one agent acting for one person, and fires its API trigger when tasks arrive that
   * the agent could claim. Delivered through the webhook transport, with its retry delays.
   */
  claudeTriggers: {
    triggers: ClaudeTrigger[];
    /** How long to let a burst of arrivals gather before firing once for all of them. */
    settleMs: number;
    /** The least time between two fires of one trigger. */
    minIntervalMs: number;
  };
  /**
   * Google Picker on the task page, for attaching Drive files. All three come from one Google
   * Cloud project; the browser gets its own drive.file token, so the server holds no Google
   * credential. Off unless all three are set. Uploads go to `uploadFolderId` when set (a folder
   * shared with the household), otherwise to the uploader's My Drive.
   */
  /**
   * Push to the iPhone app through Apple (APNs), with a .p8 auth key. The team and bundle id
   * come from the first TUIT_IOS_APP_IDS entry. Off unless the key and its id are set; Web Push
   * needs no configuration.
   */
  apns: ApnsConfig | null;
  googlePicker: {
    apiKey: string;
    clientId: string;
    appId: string;
    uploadFolderId: string | null;
  } | null;
}

export interface ClaudeTrigger {
  /** The person the agent acts for: whose view of the tasks decides what is waiting. */
  user: string;
  agent: string;
  /** The scheduled task's fire URL, as shown when its API trigger was added. */
  url: string;
  /** The trigger's bearer token. */
  token: string;
}

const ClaudeTriggerSpec = z
  .object({
    for: z.string(),
    agent: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    url: z.url({ protocol: /^https?$/ }),
    token_env: z.string().min(1),
  })
  .strict();

/**
 * TUIT_CLAUDE_TRIGGERS is a JSON list of {for, agent, url, token_env}; each token is read from
 * the environment variable named by its token_env, so the list itself holds no secret.
 */
export function parseClaudeTriggers(
  spec: string,
  users: HouseholdUser[],
  env: NodeJS.ProcessEnv,
): ClaudeTrigger[] {
  if (!spec.trim()) return [];
  const parsed = z.array(ClaudeTriggerSpec).safeParse(JSON.parse(spec));
  if (!parsed.success) {
    throw new Error(
      `Bad TUIT_CLAUDE_TRIGGERS: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data.map((t) => {
    if (!users.some((u) => u.id === t.for)) {
      throw new Error(`TUIT_CLAUDE_TRIGGERS: "${t.for}" is not on TUIT_USERS`);
    }
    const token = env[t.token_env];
    if (!token) throw new Error(`TUIT_CLAUDE_TRIGGERS: ${t.token_env} is not set`);
    return { user: t.for, agent: t.agent, url: t.url, token };
  });
}

/**
 * TUIT_USERS is "id:email:Display Name" entries separated by commas, e.g.
 * "alex:alex@example.com:Alex,sam:sam@example.com:Sam".
 */
export function parseUsers(spec: string): HouseholdUser[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, email, ...name] = entry.split(":");
      if (!id || !email || !/^[a-z][a-z0-9_-]*$/.test(id)) {
        throw new Error(`Bad TUIT_USERS entry "${entry}" (want id:email:Name)`);
      }
      return { id, email: email.toLowerCase(), name: name.join(":") || id };
    });
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const port = Number(env.PORT ?? 8080);
  const publicUrl = new URL(env.PUBLIC_URL ?? `http://localhost:${port}`);
  const users = parseUsers(env.TUIT_USERS ?? "");
  if (users.length === 0) throw new Error("TUIT_USERS must list the household");
  const oidc =
    env.OIDC_ISSUER && env.OIDC_CLIENT_ID
      ? {
          issuer: env.OIDC_ISSUER,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET ?? "",
        }
      : null;
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  const devLogin = env.TUIT_DEV_LOGIN === "1";
  if (devLogin && !localhost) {
    throw new Error("TUIT_DEV_LOGIN is only allowed when PUBLIC_URL is localhost");
  }
  if (!oidc && !devLogin)
    throw new Error("Configure OIDC_ISSUER/OIDC_CLIENT_ID (or TUIT_DEV_LOGIN=1 locally)");
  const iosAppIds = list(env.TUIT_IOS_APP_IDS ?? "");
  return {
    databaseUrl,
    // Dev login trusts whoever can reach the port, so it only ever listens on loopback.
    host: devLogin ? "127.0.0.1" : (env.HOST ?? "0.0.0.0"),
    port,
    publicUrl,
    users,
    oidc,
    oidcTrustUnverifiedEmail: env.OIDC_TRUST_UNVERIFIED_EMAIL === "1",
    mcpJwt: env.MCP_JWT_ISSUER
      ? {
          issuer: env.MCP_JWT_ISSUER,
          audiences: list(env.MCP_JWT_AUDIENCE ?? "tuit-mcp"),
          jwksUri: env.MCP_JWT_JWKS_URI ?? null,
          personalClients: list(env.MCP_JWT_PERSONAL_CLIENTS ?? ""),
        }
      : null,
    iosAppIds,
    apns: apnsConfig(env, iosAppIds),
    devLogin,
    testClock: env.TUIT_TEST_CLOCK === "1",
    sweepIntervalMs: Number(env.TUIT_SWEEP_INTERVAL_MS ?? 60_000),
    webhooks: {
      allowPrivateNetworks: env.TUIT_WEBHOOK_ALLOW_PRIVATE_NETWORKS === "1",
      retryDelaysMs: list(env.TUIT_WEBHOOK_RETRY_DELAYS_MS ?? "10000,60000,180000,480000").map(
        Number,
      ),
    },
    claudeTriggers: {
      triggers: parseClaudeTriggers(env.TUIT_CLAUDE_TRIGGERS ?? "", users, env),
      settleMs: Number(env.TUIT_CLAUDE_TRIGGER_SETTLE_MS ?? 30_000),
      minIntervalMs: Number(env.TUIT_CLAUDE_TRIGGER_MIN_INTERVAL_MS ?? 120_000),
    },
    googlePicker:
      env.GOOGLE_PICKER_API_KEY && env.GOOGLE_PICKER_CLIENT_ID && env.GOOGLE_PICKER_APP_ID
        ? {
            apiKey: env.GOOGLE_PICKER_API_KEY,
            clientId: env.GOOGLE_PICKER_CLIENT_ID,
            appId: env.GOOGLE_PICKER_APP_ID,
            uploadFolderId: env.GOOGLE_PICKER_UPLOAD_FOLDER_ID || null,
          }
        : null,
  };
}

function apnsConfig(env: NodeJS.ProcessEnv, iosAppIds: string[]): ApnsConfig | null {
  if (!env.APNS_KEY_ID || !env.APNS_AUTH_KEY) return null;
  const appId = iosAppIds[0];
  const dot = appId?.indexOf(".") ?? -1;
  if (!appId || dot <= 0) {
    throw new Error("APNS_KEY_ID needs TUIT_IOS_APP_IDS (<Team ID>.<bundle id>) to know the app");
  }
  return {
    teamId: appId.slice(0, dot),
    bundleId: appId.slice(dot + 1),
    keyId: env.APNS_KEY_ID,
    // A key pasted into a single-line secret often has literal "\n"s.
    key: env.APNS_AUTH_KEY.replace(/\\n/g, "\n"),
    host: env.APNS_HOST || null,
  };
}
