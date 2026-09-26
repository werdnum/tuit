import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { AuthEnv } from "../api/auth.ts";
import type { App } from "../app.ts";
import { buildMcpServer } from "./tools.ts";

const rpcError = (message: string) => ({
  jsonrpc: "2.0",
  error: { code: -32000, message },
  id: null,
});

/**
 * Streamable HTTP MCP endpoint, stateless: each POST gets a fresh server bound to the caller's
 * principal. Bearer tokens only; a session cookie is never accepted here, so a browser can't be
 * tricked into driving tools with a signed-in user's authority.
 */
export function mcpRoutes(app: App): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
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
    if (c.req.method !== "POST") {
      // Stateless: no standalone SSE stream (GET) and no session to delete (DELETE).
      c.header("Allow", "POST");
      return c.json(rpcError("Method not allowed"), 405);
    }
    const server = await buildMcpServer(app, found.principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  return r;
}
