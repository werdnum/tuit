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
  mcpJwt: { issuer: string; audience: string; jwksUri: string | null } | null;
  /** Accept an email the provider doesn't mark verified. Off unless the IdP controls emails. */
  oidcTrustUnverifiedEmail: boolean;
  /** Pick-a-user login with no identity provider. Only honoured for a localhost public URL. */
  devLogin: boolean;
  /** Expose POST /__test/clock so the whole stack can be driven through time. */
  testClock: boolean;
  sweepIntervalMs: number;
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
          audience: env.MCP_JWT_AUDIENCE ?? "tuit-mcp",
          jwksUri: env.MCP_JWT_JWKS_URI ?? null,
        }
      : null,
    devLogin,
    testClock: env.TUIT_TEST_CLOCK === "1",
    sweepIntervalMs: Number(env.TUIT_SWEEP_INTERVAL_MS ?? 60_000),
  };
}
