import { afterEach, expect, test } from "vitest";
import { TestServer } from "../harness/server.ts";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.stop();
});

test("the app's sign-in callback link is claimed for the configured app only", async () => {
  const app = "H7NBC2S52X.dev.andrewgarrett.tuit";
  server = await TestServer.start({ env: { TUIT_IOS_APP_IDS: app } });
  const r = await fetch(`${server.url}/.well-known/apple-app-site-association`);
  expect(r.headers.get("content-type")).toContain("application/json");
  expect(await r.json()).toEqual({
    applinks: {
      details: [{ appIDs: [app], components: [{ "/": "/.well-known/app-auth-callback" }] }],
    },
    webcredentials: { apps: [app] },
  });
});

test("without an app configured there is nothing to claim", async () => {
  server = await TestServer.start();
  const r = await fetch(`${server.url}/.well-known/apple-app-site-association`);
  expect(r.status).toBe(404);
});
