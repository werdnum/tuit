import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type JSONRPCMessage,
  LATEST_PROTOCOL_VERSION,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { App } from "../app.ts";
import type { Principal } from "../domain/types.ts";
import { buildMcpServer } from "./tools.ts";
import { EVENTS_EXTENSION, eventsListResult, pollEvents, type Webhooks } from "./webhooks.ts";

/**
 * Protocol revision 2026-07-28 ("modern" MCP), alongside the initialize-based revisions the SDK
 * serves. Every modern request stands alone: it carries its version and client capabilities in
 * `_meta`, gets no session, and every result says `resultType`. ChatGPT only uses events over
 * this revision.
 *
 * The SDK doesn't speak it yet, so each modern request is answered by the same server the legacy
 * path builds, driven in-process through a throwaway initialize; only discovery and the Events
 * extension are answered here.
 */
export const MODERN_VERSION = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const LEGACY_VERSIONS = new Set(SUPPORTED_PROTOCOL_VERSIONS);

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const LEGACY_RESOURCE_NOT_FOUND = -32002;

const SERVER_INFO = { name: "tuit", version: "0.1.0" };

interface Rpc {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

/** Whether a POST speaks a revision newer than any the initialize handshake covers. */
export function isModern(headerVersion: string | undefined, body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const rpc = body as Partial<Rpc>;
  if (rpc.method === "initialize") return false;
  const meta = rpc.params?._meta?.[META_VERSION];
  const version = typeof meta === "string" ? meta : headerVersion;
  return version !== undefined && !LEGACY_VERSIONS.has(version);
}

/** An `Mcp-Name` value, decoding the `=?base64?...?=` form used for unsafe characters. */
function headerValue(raw: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(raw);
  return m?.[1] !== undefined ? Buffer.from(m[1], "base64").toString("utf8") : raw;
}

const NAMED_METHODS = new Set([
  "tools/call",
  "resources/read",
  "prompts/get",
  "events/poll",
  "events/subscribe",
  "events/unsubscribe",
]);

export interface ModernReply {
  status: number;
  body: unknown;
}

const error = (id: Rpc["id"] | null, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

/**
 * Header checks are lenient where the draft is still settling: a missing `Mcp-Method` or
 * `Mcp-Name` is accepted, but one that disagrees with the body is refused, so nothing in front
 * of Tuit can be routed on a header that says something else.
 */
export async function handleModern(
  app: App,
  p: Principal,
  webhooks: Webhooks,
  headers: { version?: string; method?: string; name?: string },
  rpc: Rpc,
  signal: AbortSignal,
): Promise<ModernReply> {
  if (rpc.id === undefined) return { status: 202, body: null };
  const metaVersion = rpc.params?._meta?.[META_VERSION];
  if (headers.version && typeof metaVersion === "string" && headers.version !== metaVersion) {
    return {
      status: 400,
      body: error(rpc.id, HEADER_MISMATCH, "MCP-Protocol-Version doesn't match the request _meta"),
    };
  }
  const version = typeof metaVersion === "string" ? metaVersion : headers.version;
  if (version !== MODERN_VERSION) {
    return {
      status: 400,
      body: error(rpc.id, UNSUPPORTED_VERSION, "Unsupported protocol version", {
        supported: [MODERN_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
        requested: version ?? null,
      }),
    };
  }
  if (headers.method !== undefined && headers.method !== rpc.method) {
    return {
      status: 400,
      body: error(rpc.id, HEADER_MISMATCH, "Mcp-Method doesn't match the request method"),
    };
  }
  if (headers.name !== undefined && NAMED_METHODS.has(rpc.method)) {
    const named = rpc.params?.name ?? rpc.params?.uri;
    if (headerValue(headers.name) !== named) {
      return {
        status: 400,
        body: error(rpc.id, HEADER_MISMATCH, "Mcp-Name doesn't match the request"),
      };
    }
  }

  const complete = (result: Record<string, unknown>): ModernReply => {
    const meta = (result._meta as Record<string, unknown> | undefined) ?? {};
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          ...result,
          resultType: "complete",
          _meta: { ...meta, [META_SERVER_INFO]: SERVER_INFO },
        },
      },
    };
  };
  try {
    switch (rpc.method) {
      case "server/discover": {
        const init = await legacy(app, p, null, signal);
        const caps = { ...(init.capabilities as Record<string, unknown>) };
        // Resource subscriptions need a session; modern clients have events instead.
        if (caps.resources) caps.resources = {};
        return complete({
          supportedVersions: [MODERN_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: {
            ...caps,
            extensions: { [EVENTS_EXTENSION]: {} },
            // ChatGPT looks for events here, as the extension's earlier sketch had it.
            events: {},
          },
          ...(init.instructions ? { instructions: init.instructions } : {}),
        });
      }
      case "events/list":
        return complete(eventsListResult());
      case "events/poll":
        return complete(await pollEvents(app, p, rpc.params));
      case "events/subscribe":
        return complete(await webhooks.subscribe(p, rpc.params));
      case "events/unsubscribe":
        return complete(await webhooks.unsubscribe(p, rpc.params));
      case "events/stream":
        return {
          status: 200,
          body: error(rpc.id, -32026, "Push delivery isn't offered; use webhook or poll", {
            feature: "deliveryMode",
            value: "push",
          }),
        };
      case "initialize":
      case "resources/subscribe":
      case "resources/unsubscribe":
      case "subscriptions/listen":
        return {
          status: 404,
          body: error(rpc.id, METHOD_NOT_FOUND, `Method not found: ${rpc.method}`),
        };
    }
    const reply = await legacy(app, p, rpc, signal);
    return complete(reply);
  } catch (err) {
    if (err instanceof McpError) {
      const code = err.code === LEGACY_RESOURCE_NOT_FOUND ? INVALID_PARAMS : err.code;
      return {
        status: code === METHOD_NOT_FOUND ? 404 : 200,
        body: error(rpc.id, code, err.message.replace(/^MCP error -?\d+: /, ""), err.data),
      };
    }
    throw err;
  }
}

/**
 * Answer one request with the legacy server, in-process: initialize, then the request. With no
 * request, the initialize result itself (capabilities and instructions, for discovery).
 */
async function legacy(
  app: App,
  p: Principal,
  rpc: Rpc | null,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const server = await buildMcpServer(app, p, null);
  const [client, end] = InMemoryTransport.createLinkedPair();
  const replies = new Map<string | number, (m: JSONRPCMessage) => void>();
  client.onmessage = (m) => {
    if ("id" in m && m.id !== undefined && ("result" in m || "error" in m)) replies.get(m.id)?.(m);
  };
  await server.connect(end);
  await client.start();
  const call = (id: string, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      replies.set(id, (m) => {
        if ("error" in m) {
          const e = m.error as { code: number; message: string; data?: unknown };
          reject(new McpError(e.code, e.message, e.data));
        } else resolve((m as { result: Record<string, unknown> }).result);
      });
      void client.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    });
  try {
    const init = await call("init", "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "tuit-modern", version: "1" },
    });
    if (!rpc) return init;
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Closing the response is how a modern client cancels; a cancelled request gets no reply.
    let onAbort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        void client.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "request" },
        });
        reject(new McpError(-32800, "Request cancelled"));
      };
    });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([call("request", rpc.method, rpc.params ?? {}), cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  } finally {
    await server.close();
  }
}
