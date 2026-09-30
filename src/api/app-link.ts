import { Hono } from "hono";
import { html } from "hono/html";
import type { App } from "../app.ts";
import type { AuthEnv } from "./auth.ts";

/**
 * Where the identity provider sends the iPhone app's sign-in code: an https Universal Link on
 * this host that only the app named in apple-app-site-association can receive. A custom scheme
 * like tuit:// could be claimed by any app, which could then finish someone's sign-in.
 */
export const APP_CALLBACK_PATH = "/.well-known/app-auth-callback";

/** Apple's side of the app's sign-in callback. Tuit itself issues nothing here. */
export function appLinkRoutes(app: App): Hono<AuthEnv> {
  const apps = app.config.iosAppIds;
  const r = new Hono<AuthEnv>();

  // Apple fetches this (through its CDN) to learn which apps may receive the callback link.
  r.get("/.well-known/apple-app-site-association", (c) => {
    if (apps.length === 0) return c.json({ error: "not_found", message: "No iOS app" }, 404);
    return c.json({
      applinks: { details: [{ appIDs: apps, components: [{ "/": APP_CALLBACK_PATH }] }] },
      webcredentials: { apps },
    });
  });

  // Only seen when the app didn't catch the link, e.g. it was opened in a desktop browser.
  r.get(APP_CALLBACK_PATH, (c) =>
    c.html(
      html`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Tuit</title><body style="font: 17px/1.45 -apple-system, system-ui, sans-serif; padding: 24px"><p>Signing in to the Tuit app happens inside the app. Go back to it and tap “Sign in” again.</p></body>`,
    ),
  );

  return r;
}
