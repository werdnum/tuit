import type { TestServer } from "./server.ts";

/**
 * Sign in over plain HTTP by walking the real OIDC redirect dance (node-oidc-provider's dev
 * login and consent screens) with a cookie jar. Returns a fetch bound to the session.
 */
export async function signIn(
  server: TestServer,
  user: string,
  next = "/",
): Promise<{ fetch: (path: string, init?: RequestInit) => Promise<Response>; landed: string }> {
  const jar = new Map<string, Map<string, string>>();
  const cookieHeader = (url: URL) =>
    [...(jar.get(url.host) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (url: URL, res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const idx = pair?.indexOf("=") ?? -1;
      if (!pair || idx < 0) continue;
      const hostJar = jar.get(url.host) ?? new Map<string, string>();
      const value = pair.slice(idx + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === "")
        hostJar.delete(pair.slice(0, idx));
      else hostJar.set(pair.slice(0, idx), value);
      jar.set(url.host, hostJar);
    }
  };
  const go = async (url: URL, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers as Record<string, string>), cookie: cookieHeader(url) },
    });
    store(url, res);
    return res;
  };

  let url = new URL(`/login?next=${encodeURIComponent(next)}`, server.url);
  let res = await go(url);
  for (let hops = 0; hops < 20; hops++) {
    if (res.status >= 300 && res.status < 400) {
      url = new URL(res.headers.get("location") as string, url);
      if (
        url.origin === new URL(server.url).origin &&
        !url.pathname.startsWith("/auth/callback") &&
        !url.pathname.startsWith("/login")
      ) {
        break;
      }
      res = await go(url);
      continue;
    }
    const page = await res.text();
    const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
    if (!action) throw new Error(`Stuck at ${url.href}: ${res.status} ${page.slice(0, 300)}`);
    const form = new URLSearchParams();
    for (const [tag] of page.matchAll(/<input[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(tag)?.[1];
      if (name) form.set(name, /value="([^"]*)"/.exec(tag)?.[1] ?? "");
    }
    if (form.has("login")) {
      form.set("login", user);
      form.set("password", "anything");
    }
    url = new URL(action.replaceAll("&amp;", "&"), url);
    res = await go(url, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }
  const origin = new URL(server.url).origin;
  return {
    landed: url.pathname + url.search,
    fetch: (path, init = {}) => {
      const target = new URL(path, server.url);
      return go(target, {
        ...init,
        headers: { origin, ...(init.headers as Record<string, string>) },
      });
    },
  };
}
