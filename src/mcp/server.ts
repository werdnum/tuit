import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { AuthEnv } from "../api/auth.ts";
import type { App } from "../app.ts";
import { McpSessions } from "./events.ts";
import { handleModern, isModern } from "./modern.ts";
import { buildMcpServer } from "./tools.ts";

const rpcError = (message: string, code = -32000) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
});

const SESSION_HEADER = "mcp-session-id";

/** The JSON-RPC body, or undefined if it isn't JSON (the transport answers that properly). */
async function peekBody(req: Request): Promise<unknown> {
  try {
    return await req.clone().json();
  } catch {
    return undefined;
  }
}

/** Whether a JSON-RPC body (one message or a batch) starts a session. */
function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && typeof m === "object" && m.method === "initialize");
}

/**
 * Streamable HTTP MCP endpoint. Each POST gets a fresh server bound to the caller's principal;
 * the session (from initialize) only carries resource subscriptions and the position of its
 * event stream (GET), and lives in the database, so it survives restarts. Bearer tokens only;
 * a session cookie is never accepted here, so a browser can't be tricked into driving tools
 * with a signed-in user's authority.
 */
export function mcpRoutes(app: App): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  const sessions = new McpSessions(app);
  r.all("/", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const found = /^bearer\s/i.test(header) ? await app.auth.principal(c) : null;
    if (!found || found.viaSession) {
      const meta = `resource_metadata="${app.config.publicUrl.origin}/.well-known/oauth-protected-resource"`;
      c.header(
        "WWW-Authenticate",
        header
          ? `Bearer realm="tuit", error="invalid_token", ${meta}`
          : `Bearer realm="tuit", ${meta}`,
      );
      return c.json(rpcError("Send an agent token: Authorization: Bearer <token>"), 401);
    }
    const p = found.principal;
    const method = c.req.method;
    const body = method === "POST" ? await peekBody(c.req.raw) : undefined;
    if (method === "POST" && isModern(c.req.header("mcp-protocol-version"), body)) {
      const reply = await handleModern(
        app,
        p,
        app.webhooks,
        {
          version: c.req.header("mcp-protocol-version"),
          method: c.req.header("mcp-method"),
          name: c.req.header("mcp-name"),
        },
        body as Parameters<typeof handleModern>[4],
        c.req.raw.signal,
      );
      if (reply.body === null) return c.body(null, 202);
      return c.json(reply.body, reply.status as 200);
    }
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      c.header("Allow", "GET, POST, DELETE");
      return c.json(rpcError("Method not allowed"), 405);
    }

    const sent = c.req.header(SESSION_HEADER);
    // A session someone else started is as unknown as one that never existed.
    const session = sent ? await sessions.get(p, sent) : null;
    if (sent && !session) return c.json(rpcError("Session not found", -32001), 404);
    if (method !== "POST") {
      if (!session) return c.json(rpcError(`Send the ${SESSION_HEADER} header`), 400);
      if (method === "DELETE") {
        await sessions.delete(session.id);
        return c.body(null, 204);
      }
      if (!(c.req.header("accept") ?? "").includes("text/event-stream")) {
        return c.json(rpcError("Accept text/event-stream"), 406);
      }
      return sessions.stream(c, p, session);
    }

    const starting = !session && isInitialize(body);
    const id = starting ? await sessions.create(p) : (session?.id ?? null);
    const server = await buildMcpServer(app, p, id ? { sessions, id } : null);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(c.req.raw);
      if (!starting || !id || !res.ok) return res;
      const headers = new Headers(res.headers);
      headers.set(SESSION_HEADER, id);
      return new Response(res.body, { status: res.status, headers });
    } finally {
      await server.close();
    }
  });
  return r;
}
