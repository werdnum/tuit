import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Api, TestServer } from "../harness/server.ts";
import { signIn } from "../harness/session.ts";

let server: TestServer;
const redirectUri = "https://claude.ai/api/mcp/auth_callback";

beforeEach(async () => {
  server = await TestServer.start();
});

afterEach(async () => {
  await server.stop();
});

async function register(): Promise<string> {
  const r = await fetch(`${server.url}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri] }),
  });
  return ((await r.json()) as { client_id: string }).client_id;
}

/** Walk the connector flow as claude.ai would, with the person approving on the consent page. */
async function connect(user: string, decision: "allow" | "deny", access = "write", scope?: string) {
  const clientId = await register();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${server.url}/mcp`,
    ...(scope ? { scope } : {}),
  })}`;
  const session = await signIn(server, user, authorize);
  const consent = await (await session.fetch(authorize)).text();
  const fields = new URLSearchParams();
  for (const m of consent.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    fields.set(m[1] as string, (m[2] as string).replaceAll("&amp;", "&"));
  }
  fields.set("agent", "claude-web");
  fields.set("access", access);
  fields.set("decision", decision);
  const approved = await session.fetch("/oauth/authorize", {
    method: "POST",
    body: fields,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const back = new URL(approved.headers.get("location") as string);
  return { clientId, verifier, back, consent };
}

async function exchange(form: Record<string, string>) {
  const r = await fetch(`${server.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return { status: r.status, json: (await r.json()) as any };
}

test("the MCP resource advertises its authorization server", async () => {
  const prm = await (await fetch(`${server.url}/.well-known/oauth-protected-resource`)).json();
  const as = await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json();

  expect(prm).toMatchObject({ resource: `${server.url}/mcp`, authorization_servers: [server.url] });
  expect(prm.scopes_supported).toEqual(["tasks", "tasks:read"]);
  expect(as.code_challenge_methods_supported).toEqual(["S256"]);
});

test("an approved connector gets a token that acts for the approving person as that agent", async () => {
  const { clientId, verifier, back, consent } = await connect("sam", "allow");
  expect(consent).toContain("acting for <strong>Sam</strong>");

  const tok = await exchange({
    grant_type: "authorization_code",
    code: back.searchParams.get("code") as string,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  expect(back.searchParams.get("state")).toBe("xyz");
  const me = await new Api(server.url, tok.json.access_token).get("/api/me");
  expect(me.user.id).toBe("sam");
  expect(me.agent).toBe("claude-web");
});

test("a code can't be redeemed without the PKCE verifier, or twice", async () => {
  const { clientId, verifier, back } = await connect("alex", "allow");
  const code = back.searchParams.get("code") as string;
  const base = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  };

  const wrong = await exchange({ ...base, code_verifier: "not-the-verifier" });
  const replay = await exchange({ ...base, code_verifier: verifier });

  expect(wrong.json.error).toBe("invalid_grant");
  expect(replay.json.error).toBe("invalid_grant");
});

test("declining sends the connector back with access_denied", async () => {
  const { back } = await connect("alex", "deny");

  expect(back.searchParams.get("error")).toBe("access_denied");
  expect(back.searchParams.get("code")).toBeNull();
});

test("a refresh token rotates and the old access token stops working", async () => {
  const { clientId, verifier, back } = await connect("alex", "allow", "read");
  const first = await exchange({
    grant_type: "authorization_code",
    code: back.searchParams.get("code") as string,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  const second = await exchange({
    grant_type: "refresh_token",
    refresh_token: first.json.refresh_token,
    client_id: clientId,
  });
  const reused = await exchange({
    grant_type: "refresh_token",
    refresh_token: first.json.refresh_token,
    client_id: clientId,
  });

  expect(second.json.scope).toBe("tasks:read");
  expect((await new Api(server.url, first.json.access_token).call("GET", "/api/me")).status).toBe(
    401,
  );
  expect((await new Api(server.url, second.json.access_token).call("GET", "/api/me")).status).toBe(
    200,
  );
  expect(reused.json.error).toBe("invalid_grant");
});

test("registration refuses non-https redirect URIs", async () => {
  const r = await fetch(`${server.url}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "evil", redirect_uris: ["http://evil.example/cb"] }),
  });

  expect(r.status).toBe(400);
});

test("a connector that asked for read-only access can't be granted write", async () => {
  const { clientId, verifier, back, consent } = await connect(
    "alex",
    "allow",
    "write",
    "tasks:read",
  );

  const tok = await exchange({
    grant_type: "authorization_code",
    code: back.searchParams.get("code") as string,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  expect(consent).not.toContain("Read and update tasks");
  expect(tok.json.scope).toBe("tasks:read");
  const write = await new Api(server.url, tok.json.access_token).call("POST", "/api/tasks", {
    title: "x",
  });
  expect(write.status).toBe(403);
});
