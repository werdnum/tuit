import { expect, nowRow, test } from "./fixtures.ts";

test("capturing with a #tag files it in an area, and the area chip narrows Now", async ({
  page,
  signIn,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", { title: "mow the lawn", area: "home" });
  await signIn(page, "alex");
  const box = page.getByRole("textbox", { name: "Capture a task" });

  await box.fill("#tuit fix the feed cursor");
  await box.press("Enter");
  await expect(nowRow(page, "fix the feed cursor")).toContainText("#tuit");

  await page
    .getByRole("navigation", { name: "Areas" })
    .getByRole("link", { name: "#tuit" })
    .click();
  await expect(page).toHaveURL(/\?area=tuit$/);
  await expect(nowRow(page, "fix the feed cursor")).toBeVisible();
  await expect(nowRow(page, "mow the lawn")).toHaveCount(0);
  await page.getByRole("button", { name: "Enough for now" }).click();
  await expect(page).toHaveURL(/\?area=tuit$/);
  await page.getByRole("button", { name: "Show anyway" }).click();
  await expect(page).toHaveURL(/\?area=tuit$/);

  await page.getByRole("textbox", { name: "Capture a task" }).fill("write the area docs");
  await page.keyboard.press("Enter");
  await expect(nowRow(page, "write the area docs")).toBeVisible();
  const all = await alexApi.get("/api/tasks");
  expect(all.tasks.find((t: { title: string }) => t.title === "write the area docs").area).toBe(
    "tuit",
  );
});

test("pinning a task from its page puts it at the top of Now", async ({
  page,
  signIn,
  alexApi,
}) => {
  for (let i = 1; i <= 4; i++) await alexApi.post("/api/tasks", { title: `chore ${i}` });
  await signIn(page, "alex");
  await nowRow(page, "chore 3").getByRole("link").click();

  await page.getByRole("button", { name: "Pin to top" }).click();
  await expect(page.getByRole("button", { name: "Unpin" })).toBeVisible();
  await page.goto("/");

  await expect(page.locator("main li[data-task]").first()).toContainText("chore 3");
});

test("capturing while looking at tasks with no area files the task without one", async ({
  page,
  signIn,
  alexApi,
}) => {
  await signIn(page, "alex");
  await page.goto("/?area=none");

  await page.getByRole("textbox", { name: "Capture a task" }).fill("ring the vet");
  await page.keyboard.press("Enter");

  await expect(nowRow(page, "ring the vet")).toBeVisible();
  const all = await alexApi.get("/api/tasks");
  expect(all.tasks.find((t: { title: string }) => t.title === "ring the vet").area).toBeNull();
});
