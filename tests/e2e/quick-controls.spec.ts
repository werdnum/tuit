import type { Page } from "@playwright/test";
import { expect, nowRow, test } from "./fixtures.ts";

const openMenu = (page: Page, title: string) =>
  nowRow(page, title).getByLabel(`Actions: ${title}`).click();

test("a row's menu on Now snoozes, pins, files and drops a task without opening it", async ({
  page,
  signIn,
  alexApi,
}) => {
  for (const title of ["chore 1", "chore 2", "chore 3", "chore 4"]) {
    await alexApi.post("/api/tasks", { title });
  }
  await alexApi.post("/api/tasks", { title: "mow the lawn", area: "home" });
  await signIn(page, "alex");

  await openMenu(page, "chore 3");
  await nowRow(page, "chore 3").getByRole("button", { name: "Pin to top" }).click();
  await expect(page.locator("main li[data-task]").first()).toContainText("chore 3");
  await expect(page).toHaveURL(/\/$/);

  await openMenu(page, "chore 1");
  await nowRow(page, "chore 1").getByRole("button", { name: "Snooze: Tomorrow" }).click();
  await expect(nowRow(page, "chore 1")).toHaveCount(0);

  await openMenu(page, "chore 2");
  await nowRow(page, "chore 2").getByRole("combobox", { name: "Area" }).fill("home");
  await nowRow(page, "chore 2").getByRole("button", { name: "Set area" }).click();
  await expect(nowRow(page, "chore 2")).toContainText("#home");

  await openMenu(page, "chore 4");
  await nowRow(page, "chore 4").getByRole("button", { name: "No longer relevant" }).click();
  await expect(nowRow(page, "chore 4")).toHaveCount(0);

  const all = await alexApi.get("/api/tasks");
  const byTitle = (t: string) => all.tasks.find((x: { title: string }) => x.title === t);
  expect(byTitle("chore 2").area).toBe("home");
});

test("only one row's menu is open at a time, and the tick still completes", async ({
  page,
  signIn,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", { title: "call the bank" });
  await alexApi.post("/api/tasks", { title: "book the dentist" });
  await signIn(page, "alex");

  await openMenu(page, "call the bank");
  await expect(
    nowRow(page, "call the bank").getByRole("button", { name: "Pin to top" }),
  ).toBeVisible();
  await openMenu(page, "book the dentist");
  await expect(
    nowRow(page, "call the bank").getByRole("button", { name: "Pin to top" }),
  ).toBeHidden();

  await nowRow(page, "call the bank").getByRole("button", { name: "Done: call the bank" }).click();
  await expect(nowRow(page, "call the bank")).toHaveClass(/done/);
  await expect(nowRow(page, "call the bank").getByLabel("Actions: call the bank")).toHaveCount(0);
});
