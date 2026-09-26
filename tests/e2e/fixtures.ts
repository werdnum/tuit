import { type Browser, test as base, devices, expect, type Page } from "@playwright/test";
import { type Api, TestServer } from "../harness/server.ts";

/** Monday morning in Sydney. */
export const MONDAY = "2026-10-05T09:00:00+11:00";

interface Fixtures {
  server: TestServer;
  /** Sign in through the real OIDC login screen. Any login name "x" becomes x@example.com. */
  signIn: (page: Page, login: string) => Promise<Page>;
  /** A separate phone (its own browser context) signed in as `login`. */
  phone: (login: string) => Promise<Page>;
  /** REST client acting for alex, for arranging data. */
  alexApi: Api;
}

async function signIn(server: TestServer, page: Page, login: string): Promise<Page> {
  await page.goto(`${server.url}/`);
  await page.locator("input[name=login]").fill(login);
  await page.locator("input[name=password]").fill("any");
  await page.getByRole("button", { name: "Sign-in" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(`${server.url}/`);
  await expect(page.getByRole("textbox", { name: "Capture a task" })).toBeVisible();
  return page;
}

async function newPhone(browser: Browser, baseURL: string): Promise<Page> {
  const context = await browser.newContext({ ...devices["iPhone 15"], baseURL });
  return context.newPage();
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const server = await TestServer.start();
    await server.setClock(MONDAY);
    await use(server);
    await server.stop();
  },
  baseURL: async ({ server }, use) => {
    await use(server.url);
  },
  signIn: async ({ server }, use) => {
    await use((page, login) => signIn(server, page, login));
  },
  phone: async ({ browser, server }, use) => {
    const pages: Page[] = [];
    await use(async (login) => {
      const page = await newPhone(browser, server.url);
      pages.push(page);
      return signIn(server, page, login);
    });
    for (const p of pages) await p.context().close();
  },
  alexApi: async ({ server }, use) => {
    await use(await server.api("alex", "setup"));
  },
});

export { expect };

/** Rows of a named list on the page (Today, New since this morning, Urgent, Results...). */
export const rows = (page: Page, list: string) =>
  page.getByRole("list", { name: list, exact: true }).getByRole("listitem");

/** Any row on Now for this title, wherever it's shown. */
export const nowRow = (page: Page, title: string) =>
  page.locator("main li[data-task]").filter({ hasText: title });
