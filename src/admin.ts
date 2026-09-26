import { parseArgs } from "node:util";
import { Auth } from "./api/auth.ts";
import { seedUsers } from "./app.ts";
import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { Database } from "./db/db.ts";

const USAGE = `Operator commands (run where DATABASE_URL and TUIT_USERS are set):

  admin migrate
  admin mint-token --user <id> --agent <name> [--scope read|write] [--label text]
  admin mint-token --user <id> --personal [--label text]
  admin mint-display-token --by <user id> [--label text]

Agent tokens act for exactly one person as a named agent; a personal token is that person
(for their own CLI); display tokens see household items only.`;

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    user: { type: "string" },
    agent: { type: "string" },
    scope: { type: "string" },
    label: { type: "string" },
    by: { type: "string" },
    personal: { type: "boolean" },
  },
});

const config = loadConfig({
  TUIT_DEV_LOGIN: "0",
  OIDC_ISSUER: "unused",
  OIDC_CLIENT_ID: "unused",
  ...process.env,
});
const db = new Database(config.databaseUrl);
try {
  await db.migrate();
  await seedUsers(db, config);
  const auth = new Auth(db, config, systemClock);
  if (command === "migrate") {
    console.log("migrated");
  } else if (command === "mint-token") {
    if (!values.user || (!values.agent && !values.personal)) throw new Error(USAGE);
    const { token, info } = await auth.issueToken({
      issuedBy: values.user,
      userId: values.user,
      kind: values.personal ? "personal" : "agent",
      agent: values.agent,
      scope: values.scope === "read" ? "read" : "write",
      label: values.label,
    });
    console.error(
      `token ${info.id}: ${info.agent ? `agent:${info.agent} acting for` : "personal token for"} ${values.user} (${info.scope})`,
    );
    console.log(token);
  } else if (command === "mint-display-token") {
    if (!values.by) throw new Error(USAGE);
    const { token, info } = await auth.issueToken({
      issuedBy: values.by,
      userId: null,
      kind: "display",
      label: values.label,
    });
    console.error(`display token ${info.id} (household items only)`);
    console.log(token);
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} finally {
  await db.close();
}
