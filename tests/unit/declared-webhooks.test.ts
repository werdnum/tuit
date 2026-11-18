import { expect, test } from "vitest";
import { parseDeclaredWebhooks } from "../../src/config.ts";

const users = [{ id: "andrew", email: "andrew@example.com", name: "Andrew" }];
const env = { TICKLE_SECRET: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0" };
const entry = {
  for: "andrew",
  agent: "muse",
  event: "inbox.changed",
  url: "https://tickle.example.com/andrew-muse",
  secret_env: "TICKLE_SECRET",
};
const parse = (entries: unknown[]) => parseDeclaredWebhooks(JSON.stringify(entries), users, env);

test("a declared webhook reads its secret from the environment", () => {
  expect(parseDeclaredWebhooks("", users, env)).toEqual([]);
  expect(parse([entry])).toEqual([
    {
      user: "andrew",
      agent: "muse",
      event: "inbox.changed",
      arguments: {},
      url: "https://tickle.example.com/andrew-muse",
      secret: env.TICKLE_SECRET,
    },
  ]);
  expect(parse([{ ...entry, agent: undefined }])[0]?.agent).toBeNull();
});

test("a declared webhook must name a household member, a set secret and a known shape", () => {
  expect(() => parse([{ ...entry, for: "nobody" }])).toThrow(/"nobody" is not on TUIT_USERS/);
  expect(() => parse([{ ...entry, secret_env: "UNSET" }])).toThrow(/UNSET is not set/);
  expect(() => parse([{ ...entry, secret: "whsec_inline" }])).toThrow(/Bad TUIT_WEBHOOKS/);
  expect(() => parse([{ ...entry, url: "ftp://tickle.example.com/" }])).toThrow(
    /Bad TUIT_WEBHOOKS/,
  );
  expect(() => parse([{ ...entry, agent: "not an agent" }])).toThrow(/Bad TUIT_WEBHOOKS/);
});
