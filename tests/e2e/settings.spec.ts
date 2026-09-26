import { expect, test } from "./fixtures.ts";

test("an agent token is shown once, then only listed", async ({ page, signIn }) => {
  await signIn(page, "alex");
  await page.goto("/settings");

  await page.locator("summary", { hasText: "New agent token" }).click();
  await page.getByRole("textbox", { name: "Agent name" }).fill("claude");
  await page.getByRole("button", { name: "Create token" }).click();

  await expect(page.locator("#new-token")).toHaveText(/^tuit_/);
  await page.goto("/settings");
  await expect(page.locator("#new-token")).toHaveCount(0);
  await expect(page.locator("li[data-token]")).toContainText("agent:claude");
});
