import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A real MCP client session against the test server, authenticating with a bearer token. */
export class Mcp {
  readonly client: Client;
  constructor(client: Client) {
    this.client = client;
  }

  static async connect(baseUrl: string, token: string): Promise<Mcp> {
    const client = new Client({ name: "test-agent", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return new Mcp(client);
  }

  async raw(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  /** Call a tool and parse its JSON result; a tool error throws with the error text. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.raw(name, args);
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text);
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
