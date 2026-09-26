import { expect, test } from "./fixtures.ts";

test("signing in returns to the page that asked for it", async ({ page, server }) => {
  await page.goto("/search?q=gutters");

  await page.locator("input[name=login]").fill("alex");
  await page.locator("input[name=password]").fill("any");
  await page.getByRole("button", { name: "Sign-in" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(`${server.url}/search?q=gutters`);
  await expect(page.getByRole("searchbox", { name: "Search" })).toHaveValue("gutters");
});

for (const next of ["//evil.example/", "/%09/evil.example/", "/%5Cevil.example/"]) {
  test(`a login link can't send you to another site afterwards (${next})`, async ({
    page,
    server,
  }) => {
    await page.goto(`/login?next=${next}`);

    await page.locator("input[name=login]").fill("alex");
    await page.locator("input[name=password]").fill("any");
    await page.getByRole("button", { name: "Sign-in" }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page).toHaveURL(`${server.url}/`);
  });
}
