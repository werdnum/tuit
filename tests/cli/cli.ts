import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, type TestServer } from "../harness/server.ts";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export type Tuit = (...args: string[]) => Promise<Run>;

/** Runs bin/tuit as a real subprocess, with its own empty config dir so ~/.config is never read. */
export function tuitAs(server: TestServer, token: string | null, extraEnv = {}): Tuit {
  const configHome = mkdtempSync(join(tmpdir(), "tuit-cli-"));
  return (...args) =>
    new Promise((resolve) => {
      execFile(
        join(ROOT, "bin", "tuit"),
        args,
        {
          cwd: ROOT,
          env: {
            PATH: process.env.PATH,
            XDG_CONFIG_HOME: configHome,
            ...(token ? { TUIT_URL: server.url, TUIT_TOKEN: token } : {}),
            ...extraEnv,
          },
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
}

/** Like tuitAs, but fails the test on a non-zero exit and returns stdout. */
export function ok(tuit: Tuit): (...args: string[]) => Promise<string> {
  return async (...args) => {
    const r = await tuit(...args);
    if (r.code !== 0) {
      throw new Error(`tuit ${args.join(" ")} exited ${r.code}\n${r.stderr}${r.stdout}`);
    }
    return r.stdout;
  };
}
