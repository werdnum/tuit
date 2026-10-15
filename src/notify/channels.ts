import http2 from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import webpush from "web-push";
import type { Database } from "../db/db.ts";

/** What a device is sent. `url` is the page to open when the notification is tapped. */
export interface Message {
  title: string;
  body: string;
  url: string;
  taskId: string | null;
  /** Notifications with the same tag replace each other (one per task). */
  tag: string;
}

export interface Device {
  id: string;
  user_id: string;
  kind: "web" | "apns";
  address: string;
  keys: { p256dh: string; auth: string } | null;
  environment: "sandbox" | "production" | null;
  label: string;
  created_at: string;
  last_sent_at: string | null;
  last_error: string | null;
}

/**
 * How a send went. `gone` means the push service says the device will never receive anything
 * again (unsubscribed, app deleted), so it is forgotten.
 */
export type Outcome =
  | { ok: true; environment?: "sandbox" | "production" }
  | { ok: false; gone: boolean; error: string };

export interface Channel {
  send(device: Device, msg: Message): Promise<Outcome>;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * The VAPID key pair, generated on first use and kept in the database, so Web Push needs no
 * operator setup. Rotating it would orphan every browser subscription, so it never changes.
 */
export async function vapidKeys(db: Database): Promise<VapidKeys> {
  const fresh = webpush.generateVAPIDKeys();
  await db.query(
    `INSERT INTO server_keys (name, value) VALUES ('vapid', $1) ON CONFLICT (name) DO NOTHING`,
    [JSON.stringify(fresh)],
  );
  const r = await db.query<{ value: VapidKeys }>(
    `SELECT value FROM server_keys WHERE name = 'vapid'`,
  );
  return r.rows[0]?.value as VapidKeys;
}

const PUSH_TIMEOUT_MS = 15_000;

export class WebPushChannel implements Channel {
  private readonly keys: VapidKeys;
  private readonly subject: string;

  constructor(keys: VapidKeys, subject: string) {
    this.keys = keys;
    this.subject = subject;
  }

  async send(device: Device, msg: Message): Promise<Outcome> {
    if (!device.keys) return { ok: false, gone: true, error: "subscription has no keys" };
    const details = webpush.generateRequestDetails(
      { endpoint: device.address, keys: device.keys },
      JSON.stringify(msg),
      {
        vapidDetails: {
          subject: this.subject,
          publicKey: this.keys.publicKey,
          privateKey: this.keys.privateKey,
        },
        TTL: 24 * 3600,
        urgency: "high",
        topic: topicFor(msg.tag),
      },
    );
    let res: Response;
    try {
      res = await fetch(details.endpoint, {
        method: details.method,
        headers: details.headers as Record<string, string>,
        body: details.body ? new Uint8Array(details.body) : null,
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, gone: false, error: `couldn't reach the push service: ${String(err)}` };
    }
    const text = await res.text().catch(() => "");
    if (res.ok) return { ok: true };
    return {
      ok: false,
      // 404/410: the subscription has expired or been withdrawn.
      gone: res.status === 404 || res.status === 410,
      error: `push service said ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  }
}

/** Topic headers are at most 32 URL-safe characters. */
function topicFor(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "tuit";
}

/** Which push services a browser subscription may point at. Everything else is refused. */
const PUSH_HOST_SUFFIXES = [
  "push.apple.com",
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
];

export function allowedPushEndpoint(url: string, allowLoopback: boolean): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (allowLoopback && u.protocol === "http:" && u.hostname === "127.0.0.1") return true;
  if (u.protocol !== "https:" || u.username || u.password) return false;
  return PUSH_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`));
}

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  bundleId: string;
  /** The .p8 auth key, PEM. */
  key: string;
  /** Overrides both APNs hosts (tests). */
  host: string | null;
}

const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
/** Apple wants a provider token refreshed between 20 and 60 minutes old. */
const PROVIDER_TOKEN_MS = 40 * 60_000;

/**
 * Apple Push Notification service for the iPhone app, with token (.p8) authentication over
 * HTTP/2. A token registered by a development build only works against the sandbox, and an
 * App Store/TestFlight one only against production; a device that says it's one but is the
 * other is retried once on the other and remembered.
 */
export class ApnsChannel implements Channel {
  private readonly config: ApnsConfig;
  private token: { value: string; at: number } | null = null;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();

  constructor(config: ApnsConfig) {
    this.config = config;
  }

  async send(device: Device, msg: Message): Promise<Outcome> {
    const env = device.environment ?? "production";
    const first = await this.post(env, device.address, msg);
    if (first.ok || first.reason !== "BadDeviceToken" || this.config.host) {
      return first.ok ? { ok: true, environment: env } : this.failure(first);
    }
    const other = env === "production" ? "sandbox" : "production";
    const second = await this.post(other, device.address, msg);
    return second.ok ? { ok: true, environment: other } : this.failure(second);
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private failure(r: { status: number; reason: string }): Outcome {
    return {
      ok: false,
      gone: r.status === 410 || r.reason === "Unregistered",
      error: `APNs said ${r.status}${r.reason ? ` ${r.reason}` : ""}`,
    };
  }

  private async providerToken(): Promise<string> {
    if (this.token && Date.now() - this.token.at < PROVIDER_TOKEN_MS) return this.token.value;
    const key = await importPKCS8(this.config.key, "ES256");
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt()
      .sign(key);
    this.token = { value, at: Date.now() };
    return value;
  }

  private session(origin: string): http2.ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(origin);
    s.on("error", () => this.sessions.delete(origin));
    s.on("close", () => this.sessions.delete(origin));
    // Don't hold the process open for an idle connection.
    s.unref();
    this.sessions.set(origin, s);
    return s;
  }

  private async post(
    env: "sandbox" | "production",
    deviceToken: string,
    msg: Message,
  ): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
    const payload = JSON.stringify({
      aps: {
        alert: { title: msg.title, body: msg.body },
        sound: "default",
        "thread-id": msg.tag,
      },
      url: msg.url,
      ...(msg.taskId ? { task_id: msg.taskId } : {}),
    });
    const origin = this.config.host ?? APNS_HOSTS[env];
    let token: string;
    try {
      token = await this.providerToken();
    } catch (err) {
      return { ok: false, status: 0, reason: `bad APNs key: ${String(err)}` };
    }
    return new Promise((resolve) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = this.session(origin).request({
          ":method": "POST",
          ":path": `/3/device/${encodeURIComponent(deviceToken)}`,
          authorization: `bearer ${token}`,
          "apns-topic": this.config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-collapse-id": msg.tag.slice(0, 64),
          "content-type": "application/json",
        });
      } catch (err) {
        resolve({ ok: false, status: 0, reason: String(err) });
        return;
      }
      let status = 0;
      let body = "";
      req.setTimeout(PUSH_TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on("response", (h) => {
        status = Number(h[":status"]);
      });
      req.setEncoding("utf8");
      req.on("data", (d: string) => {
        body += d;
      });
      req.on("error", (err) => resolve({ ok: false, status: 0, reason: String(err) }));
      req.on("close", () => {
        if (status === 200) return resolve({ ok: true });
        let reason = "";
        try {
          reason = String((JSON.parse(body) as { reason?: string }).reason ?? "");
        } catch {}
        if (status === 403 && reason === "ExpiredProviderToken") this.token = null;
        resolve({ ok: false, status, reason: reason || (status ? "" : "no response") });
      });
      req.end(payload);
    });
  }
}
