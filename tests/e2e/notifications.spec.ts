import { expect, test } from "./fixtures.ts";

test("notification rules and quiet hours are set from Settings", async ({
  page,
  signIn,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", { title: "#garden prune the roses" });
  await signIn(page, "alex");
  await page.goto("/settings");
  await page.getByRole("link", { name: "Notifications" }).click();
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  // Whatever this browser supports, the page says something definite about this device.
  await expect(page.locator("[data-push-status]")).not.toHaveText(/Checking/);

  const rules = page.getByRole("list", { name: "Rules" });
  await expect(rules.locator("li")).toHaveCount(3);
  await expect(rules).toContainText(
    "Handed over, ready to act on or deadline is close, when it's my turn",
  );

  await page.locator("summary", { hasText: "Add a rule" }).click();
  await page.getByRole("checkbox", { name: "finished or closed" }).check();
  await page.getByRole("combobox", { name: "Whose tasks" }).selectOption("any");
  await page.getByRole("combobox", { name: "Area" }).selectOption("garden");
  await page.getByRole("combobox", { name: "Changed by" }).selectOption("agents");
  await page.getByRole("checkbox", { name: "Even during quiet hours" }).check();
  await page.getByRole("button", { name: "Add rule" }).click();

  const added = rules.locator("li").nth(3);
  await expect(added).toContainText(
    "Finished or closed, on anything I can see in #garden, by an agent",
  );
  await expect(added).toContainText("even during quiet hours");
  await added.getByRole("button", { name: "Turn off" }).click();
  await expect(rules.locator("li").nth(3)).toContainText("off");
  await rules.locator("li").nth(3).getByRole("button", { name: "Delete" }).click();
  await expect(rules.locator("li")).toHaveCount(3);

  await page.getByRole("textbox", { name: "From" }).fill("21:30");
  await page.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(page.locator(".flash")).toHaveText("Quiet from 21:30 until 07:00");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "From" })).toHaveValue("21:30");
});
