import type { Server } from "node:http";
import Provider from "oidc-provider";
import { freePort } from "./postgres.ts";

/**
 * A real OpenID Provider (node-oidc-provider) with its development login screen: any login
 * name is accepted and becomes `<name>@example.com`. Stands in for Keycloak in tests.
 */
export async function startOidcProvider(redirectUri: string): Promise<{
  issuer: string;
  clientId: string;
  clientSecret: string;
  stop: () => Promise<void>;
}> {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const clientId = "tuit";
  const clientSecret = "test-secret";
  const warn = console.warn;
  console.warn = () => {};
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
    ],
    claims: { openid: ["sub"], email: ["email", "email_verified"], profile: ["name"] },
    pkce: { required: () => true },
    findAccount: async (_ctx: unknown, sub: string) => ({
      accountId: sub,
      claims: async () => ({
        sub,
        email: sub.includes("@") ? sub : `${sub}@example.com`,
        email_verified: true,
        name: sub,
      }),
    }),
  } as any);
  console.warn = warn;
  provider.proxy = true;
  const server: Server = await new Promise((resolve) => {
    const s = provider.listen(port, "127.0.0.1", () => resolve(s));
  });
  return {
    issuer,
    clientId,
    clientSecret,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
