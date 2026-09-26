import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, beforeEach, expect, test } from "vitest";
import { freePort } from "../harness/postgres.ts";
import { TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

// Remote connectors authenticate with an external authorization server (Keycloak in
// production). Here a real signing key is published from a real JWKS endpoint.

let server: TestServer;
let jwks: Server;
let issuer: string;
let sign: (
  claims: Record<string, unknown>,
  opts?: { audience?: string; expiresIn?: string },
) => Promise<string>;

beforeEach(async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const port = await freePort();
  issuer = `http://127.0.0.1:${port}/realms/home`;
  jwks = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwks.listen(port, "127.0.0.1", r));
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(opts.audience ?? "tuit-mcp")
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? "5m")
      .sign(privateKey);
  server = await TestServer.start({
    env: {
      MCP_JWT_ISSUER: issuer,
      MCP_JWT_AUDIENCE: "tuit-mcp",
      MCP_JWT_JWKS_URI: `http://127.0.0.1:${port}/certs`,
    },
  });
});

afterEach(async () => {
  await server.stop();
  await new Promise((r) => jwks.close(r));
});

const connectorToken = (email: string, extra: Record<string, unknown> = {}) =>
  sign({ email, email_verified: true, azp: "tuit-claude-ai", sub: "kc-user-1", ...extra });

async function mcpStatus(token: string): Promise<number> {
  const r = await fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return r.status;
}

test("a connector token from the issuer acts for that person as the connector's agent", async () => {
  const mcp = await Mcp.connect(server.url, await connectorToken("sam@example.com"));

  const created = await mcp.call("create_task", { title: "book the dentist" });

  expect(created.task.created_by).toEqual({ user: "sam", agent: "claude-ai" });
  await mcp.close();
});

test.each([
  [
    "another audience",
    () =>
      sign(
        { email: "sam@example.com", email_verified: true, azp: "x" },
        { audience: "family-assistant-mcp" },
      ),
  ],
  ["an email outside the household", () => connectorToken("stranger@example.com")],
  ["an unverified email", () => connectorToken("sam@example.com", { email_verified: false })],
  [
    "an expired token",
    () => sign({ email: "sam@example.com", email_verified: true }, { expiresIn: "-1m" }),
  ],
])("a token with %s is refused", async (_label, make) => {
  expect(await mcpStatus(await make())).toBe(401);
});

test("connectors are pointed at the external issuer and the built-in OAuth server is off", async () => {
  const prm = await (await fetch(`${server.url}/.well-known/oauth-protected-resource`)).json();
  const register = await fetch(`${server.url}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "x", redirect_uris: ["https://claude.ai/cb"] }),
  });

  expect(prm.authorization_servers).toEqual([issuer]);
  expect(register.status).toBe(404);
});

test("the household's own tokens still work alongside the issuer's", async () => {
  const mcp = await Mcp.connect(server.url, await server.mintToken("alex", "family-assistant"));

  const now = await mcp.call("now");

  expect(now.plan).toEqual([]);
  await mcp.close();
});
