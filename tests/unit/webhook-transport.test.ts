import { expect, test } from "vitest";
import { internetTransport, isPublicAddress } from "../../src/mcp/webhook-transport.ts";

test("only public addresses count as public", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    expect(isPublicAddress(ip), ip).toBe(true);
  }
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002:a00:1::",
    "not an ip",
  ]) {
    expect(isPublicAddress(ip), ip).toBe(false);
  }
});

test("the internet transport refuses plain http, credentials and private destinations", async () => {
  const t = internetTransport({ allowPrivateNetworks: false });
  expect(t.refuse("http://example.com/hook")).toMatch(/https/);
  expect(t.refuse("https://user:pw@example.com/hook")).toMatch(/credentials/);
  expect(t.refuse("ftp://example.com")).toMatch(/https/);
  expect(t.refuse("https://example.com/hook")).toBeNull();
  for (const url of ["https://127.0.0.1/hook", "https://[::1]/hook", "https://localhost/hook"]) {
    await expect(t.post(url, {}, "{}"), url).rejects.toMatchObject({
      reason: "connection_refused",
    });
  }
});
