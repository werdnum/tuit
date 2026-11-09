import { expect, nowRow, test } from "./fixtures.ts";

test("Now lists everything beyond today's list, paging 50 at a time", async ({
  page,
  signIn,
  alexApi,
}) => {
  for (let i = 1; i <= 57; i++) {
    await alexApi.post("/api/tasks", { title: `chore ${String(i).padStart(2, "0")}` });
  }
  await signIn(page, "alex");

  const rest = page.getByRole("list", { name: "Everything else" });
  await expect(page.getByRole("list", { name: "Today" }).locator("li[data-task]")).toHaveCount(5);
  await expect(rest.locator("li[data-task]")).toHaveCount(50);

  await page.getByRole("link", { name: "Show 2 more (2 left)" }).click();
  await expect(page).toHaveURL(/limit=100#t-/);
  await expect(rest.locator("li[data-task]")).toHaveCount(52);
  await expect(page.getByRole("link", { name: /Show \d+ more/ })).toHaveCount(0);
  await expect(nowRow(page, "chore 57")).toBeVisible();

  // Ticking a task far down the list keeps the list expanded and the place on the page.
  const before = await page.evaluate(() => window.scrollY);
  await nowRow(page, "chore 56").getByRole("button", { name: /done/i }).click();
  await expect(nowRow(page, "chore 56")).toHaveCount(0);
  await expect(rest.locator("li[data-task]")).toHaveCount(51);
  await expect(nowRow(page, "chore 57")).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before / 2);
});
