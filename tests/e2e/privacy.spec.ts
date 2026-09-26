import { expect, nowRow, test } from "./fixtures.ts";

test("Sam can't see Alex's private task anywhere", async ({ page, signIn, phone, alexApi }) => {
  const { task } = await alexApi.post("/api/tasks", { title: "Sam birthday: ring size" });
  await signIn(page, "alex");
  await page.goto(`/tasks/${task.id}`);
  await page.locator("summary", { hasText: "More" }).click();
  await page.getByLabel(/Private/).check();
  await page.getByRole("button", { name: "Save visibility" }).click();
  await expect(page.locator(".badge.private").first()).toBeVisible();

  const sam = await phone("sam");

  await expect(sam.locator("main")).toBeVisible();
  await expect(nowRow(sam, "ring size")).toHaveCount(0);
  await sam.goto("/search?q=ring%20size");
  await expect(sam.locator("main")).toContainText('Nothing matches "ring size"');
  await sam.goto("/queues/open");
  await expect(sam.locator("main")).not.toContainText("ring size");
  const direct = await sam.goto(`/tasks/${task.id}`);
  expect(direct?.status()).toBe(404);
  await expect(sam.locator("[data-error]")).toContainText("Not found");
  await expect(sam.locator("body")).not.toContainText("ring size");
});
