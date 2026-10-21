import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

/** Why a POST to a webhook endpoint failed, in the Events extension's `lastError` categories. */
export type DeliveryFailure =
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "http_4xx"
  | "http_5xx"
  | "challenge_failed";

export class DeliveryError extends Error {
  readonly reason: DeliveryFailure;
  constructor(reason: DeliveryFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface WebhookResponse {
  status: number;
  body: string;
}

/** How webhook POSTs leave the server. Production guards against SSRF; tests may relax it. */
export interface WebhookTransport {
  /** Why `url` can never be a receiver, or null if it might be. */
  refuse(url: string): string | null;
  /** POST once. Rejects with a DeliveryError when no HTTP response came back. */
  post(url: string, headers: Record<string, string>, body: string): Promise<WebhookResponse>;
}

const TIMEOUT_MS = 10_000;
/** Enough for a verification echo; receivers acknowledge, they don't reply with content. */
const MAX_RESPONSE_BYTES = 64 * 1024;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// Only global unicast IPv6 is public; within it, these carry or reach other networks.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [net, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Whether an address is on the public internet, so a POST to it can't reach a private service. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return isPublicAddress(mapped[1]);
  return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

function failure(err: NodeJS.ErrnoException): DeliveryError {
  const code = err.code ?? "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new DeliveryError("timeout", "The endpoint did not respond in time");
  }
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_OSSL)/.test(code)) {
    return new DeliveryError("tls_error", `TLS failed: ${code}`);
  }
  return new DeliveryError("connection_refused", err.message || code || "Connection failed");
}

/**
 * The internet-facing transport. Plain http and private addresses are refused unless
 * `allowPrivateNetworks`. The name is resolved and checked for each POST and the connection
 * goes to exactly the address checked (keeping the name for TLS), so DNS can't be re-pointed
 * at an internal service between check and connect. Redirects are never followed.
 */
export function internetTransport(opts: { allowPrivateNetworks: boolean }): WebhookTransport {
  const refuse = (raw: string): string | null => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return "The webhook URL is not a URL";
    }
    if (url.username || url.password) return "The webhook URL can't carry credentials";
    if (url.protocol === "https:") return null;
    if (url.protocol === "http:" && opts.allowPrivateNetworks) return null;
    return "The webhook URL must use https";
  };

  const resolve = async (hostname: string): Promise<{ address: string; family: number }> => {
    const bare = hostname.replace(/^\[|\]$/g, "");
    const all = isIP(bare)
      ? [{ address: bare, family: isIP(bare) }]
      : await lookup(bare, { all: true }).catch((err: NodeJS.ErrnoException) => {
          throw new DeliveryError("connection_refused", `Can't resolve ${bare}: ${err.code}`);
        });
    if (!opts.allowPrivateNetworks && all.some((a) => !isPublicAddress(a.address))) {
      throw new DeliveryError("connection_refused", `${bare} is not a public address`);
    }
    const first = all[0];
    if (!first) throw new DeliveryError("connection_refused", `Can't resolve ${bare}`);
    return first;
  };

  const post = async (
    raw: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<WebhookResponse> => {
    const refused = refuse(raw);
    if (refused) throw new DeliveryError("connection_refused", refused);
    const url = new URL(raw);
    const target = await resolve(url.hostname);
    const client = url.protocol === "https:" ? https : http;
    return new Promise<WebhookResponse>((done, fail) => {
      const req = client.request(
        url,
        {
          method: "POST",
          headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
          timeout: TIMEOUT_MS,
          agent: false,
          lookup: (_host, options, cb) => {
            if ((options as { all?: boolean }).all) {
              (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
                target,
              ]);
            } else {
              cb(null, target.address, target.family);
            }
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
            else res.destroy();
          });
          res.on("close", () =>
            done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", () => {});
        },
      );
      req.on("timeout", () => {
        req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
      });
      req.on("error", (err) => fail(failure(err)));
      req.end(body);
    });
  };

  return { refuse, post };
}
