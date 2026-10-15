import { createECDH, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import http2 from "node:http2";
import ece from "http_ece";
import { freePort } from "./postgres.ts";

export interface Pushed {
  title: string;
  body: string;
  url: string;
  taskId: string | null;
  tag: string;
}

/**
 * A stand-in Web Push service. Each subscription is a real key pair, so what arrives is
 * decrypted exactly as a browser would, and the VAPID header is checked for presence.
 */
export class FakeWebPush {
  readonly received: (Pushed & { device: string; headers: Record<string, string> })[] = [];
  /** Status to answer per device (default 201). */
  readonly status = new Map<string, number>();
  private server: Server | null = null;
  private base = "";
  private readonly subs = new Map<string, { ecdh: ReturnType<typeof createECDH>; auth: Buffer }>();

  static async start(): Promise<FakeWebPush> {
    const f = new FakeWebPush();
    const port = await freePort();
    f.base = `http://127.0.0.1:${port}`;
    f.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const device = (req.url ?? "").replace("/push/", "");
      const sub = f.subs.get(device);
      const code = f.status.get(device) ?? 201;
      if (!sub || code >= 300) {
        res.writeHead(sub ? code : 404);
        res.end();
        return;
      }
      const plain = ece.decrypt(Buffer.concat(chunks), {
        version: "aes128gcm",
        privateKey: sub.ecdh,
        authSecret: sub.auth.toString("base64url"),
      });
      f.received.push({
        ...(JSON.parse(plain.toString("utf8")) as Pushed),
        device,
        headers: req.headers as Record<string, string>,
      });
      res.writeHead(201);
      res.end();
    });
    await new Promise<void>((r) => f.server?.listen(port, "127.0.0.1", r));
    return f;
  }

  /** A new browser subscription, as PushSubscription.toJSON() would give it. */
  subscription(name: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = randomBytes(16);
    this.subs.set(name, { ecdh, auth });
    return {
      endpoint: `${this.base}/push/${name}`,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    };
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export interface ApnsRequest {
  path: string;
  headers: http2.IncomingHttpHeaders;
  payload: {
    aps: { alert: { title: string; body: string }; "thread-id": string };
    url: string;
    task_id?: string;
  };
}

/** A stand-in for Apple's push service over cleartext HTTP/2, with a real .p8-style key. */
export class FakeApns {
  readonly received: ApnsRequest[] = [];
  /** Answer per device token: [status, reason]. Default 200. */
  readonly answer = new Map<string, [number, string]>();
  readonly keyPem: string;
  readonly publicKey: KeyObject;
  url = "";
  private server: http2.Http2Server | null = null;

  private constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.publicKey = publicKey;
  }

  static async start(): Promise<FakeApns> {
    const f = new FakeApns();
    const port = await freePort();
    f.url = `http://127.0.0.1:${port}`;
    f.server = http2.createServer();
    f.server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (d: string) => {
        body += d;
      });
      stream.on("end", () => {
        const path = String(headers[":path"]);
        const token = path.split("/").at(-1) ?? "";
        const [status, reason] = f.answer.get(token) ?? [200, ""];
        if (status === 200) f.received.push({ path, headers, payload: JSON.parse(body) });
        stream.respond({ ":status": status });
        stream.end(reason ? JSON.stringify({ reason }) : "");
      });
    });
    await new Promise<void>((r) => f.server?.listen(port, "127.0.0.1", r));
    return f;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
