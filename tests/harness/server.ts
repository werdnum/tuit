import { type ChildProcess, execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { startOidcProvider } from "./oidc.ts";
import { createDatabase, freePort, waitFor } from "./postgres.ts";

const execFileP = promisify(execFile);
export const ROOT = join(import.meta.dirname, "..", "..");
export const USERS = "alex:alex@example.com:Alex,sam:sam@example.com:Sam";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/** A tiny JSON client for the REST API, authenticating with a bearer token. */
export class Api {
  readonly base: string;
  readonly token: string;
  constructor(base: string, token: string) {
    this.base = base;
    this.token = token;
  }

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  }

  private async ok(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.call(method, path, body);
    if (r.status >= 300) throw new ApiError(r.status, r.json);
    return r.json;
  }

  get(path: string): Promise<any> {
    return this.ok("GET", path);
  }
  post(path: string, body: unknown = {}): Promise<any> {
    return this.ok("POST", path, body);
  }
  patch(path: string, body: unknown): Promise<any> {
    return this.ok("PATCH", path, body);
  }
}

export interface StartOptions {
  /** Use the pick-a-user dev login instead of OIDC. */
  devLogin?: boolean;
  /** Extra environment for the server process. */
  env?: Record<string, string>;
}

/**
 * The real server as a child process against its own fresh database, with the test clock
 * enabled and a real OIDC provider for sign-in. Restartable to test persistence.
 */
export class TestServer {
  url = "";
  dbUrl = "";
  env: NodeJS.ProcessEnv = {};
  output = "";
  private proc: ChildProcess | null = null;
  private stopIdp: (() => Promise<void>) | null = null;
  private clockAt: string | null = null;

  static async start(opts: StartOptions = {}): Promise<TestServer> {
    const s = new TestServer();
    const adminUrl = process.env.TUIT_TEST_PG_URL;
    if (!adminUrl) throw new Error("TUIT_TEST_PG_URL not set (global setup should start postgres)");
    s.dbUrl = await createDatabase(adminUrl);
    const port = await freePort();
    s.url = `http://127.0.0.1:${port}`;
    s.env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: s.dbUrl,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: s.url,
      TUIT_USERS: USERS,
      TUIT_TEST_CLOCK: "1",
      TUIT_SWEEP_INTERVAL_MS: "3600000",
    };
    Object.assign(s.env, opts.env ?? {});
    if (opts.devLogin) {
      s.env.TUIT_DEV_LOGIN = "1";
    } else {
      const idp = await startOidcProvider(`${s.url}/auth/callback`);
      s.stopIdp = idp.stop;
      Object.assign(s.env, {
        OIDC_ISSUER: idp.issuer,
        OIDC_CLIENT_ID: idp.clientId,
        OIDC_CLIENT_SECRET: idp.clientSecret,
      });
    }
    await s.launch();
    return s;
  }

  private async launch(): Promise<void> {
    this.output = "";
    const proc = spawn(process.execPath, ["src/server.ts"], {
      cwd: ROOT,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => {
      this.output += d;
    });
    proc.stderr?.on("data", (d) => {
      this.output += d;
    });
    this.proc = proc;
    await waitFor(`server at ${this.url}\n${this.output}`, async () => {
      if (proc.exitCode !== null) throw new Error(`server exited:\n${this.output}`);
      const r = await fetch(`${this.url}/healthz`);
      return r.ok ? true : undefined;
    });
    // The clock lives in the server process; re-apply it after a restart.
    if (this.clockAt) await this.setClock(this.clockAt);
  }

  async restart(): Promise<void> {
    await this.kill();
    await this.launch();
  }

  private async kill(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await exited;
  }

  async stop(): Promise<void> {
    await this.kill();
    await this.stopIdp?.();
  }

  /** Pin the server clock (ISO instant, or a Date). Pass null to return to real time. */
  async setClock(at: string | Date | null): Promise<void> {
    const iso = at === null ? null : new Date(at).toISOString();
    this.clockAt = iso;
    const r = await fetch(`${this.url}/__test/clock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: iso }),
    });
    if (!r.ok) throw new Error(`setClock failed: ${r.status}`);
  }

  /** Mint a token through the operator command, exactly as a deployment would. */
  async mintToken(user: string, agent: string, scope: "read" | "write" = "write"): Promise<string> {
    const { stdout } = await execFileP(
      process.execPath,
      ["src/admin.ts", "mint-token", "--user", user, "--agent", agent, "--scope", scope],
      { cwd: ROOT, env: this.env },
    );
    return stdout.trim();
  }

  async mintPersonalToken(user: string): Promise<string> {
    const { stdout } = await execFileP(
      process.execPath,
      ["src/admin.ts", "mint-token", "--user", user, "--personal"],
      { cwd: ROOT, env: this.env },
    );
    return stdout.trim();
  }

  async mintDisplayToken(by: string): Promise<string> {
    const { stdout } = await execFileP(
      process.execPath,
      ["src/admin.ts", "mint-display-token", "--by", by],
      {
        cwd: ROOT,
        env: this.env,
      },
    );
    return stdout.trim();
  }

  /** The person themself, as with their own CLI (a personal token). */
  async human(user: string): Promise<Api> {
    return new Api(this.url, await this.mintPersonalToken(user));
  }

  async api(user: string, agent = "test"): Promise<Api> {
    return new Api(this.url, await this.mintToken(user, agent));
  }
}
