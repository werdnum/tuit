import { expect, nowRow, test } from "./fixtures.ts";

test("a task added elsewhere appears on Now without a refresh", async ({
  page,
  signIn,
  alexApi,
}) => {
  await signIn(page, "alex");

  await alexApi.post("/api/tasks", { title: "Pick up the dry cleaning" });

  await expect(nowRow(page, "Pick up the dry cleaning")).toBeVisible();
});

test("a live update leaves half-typed text and focus where they were", async ({
  page,
  signIn,
  alexApi,
}) => {
  await signIn(page, "alex");
  const box = page.getByRole("textbox", { name: "Capture a task" });
  await box.fill("ring the plumb");

  await alexApi.post("/api/tasks", { title: "Book the dentist" });

  await expect(nowRow(page, "Book the dentist")).toBeVisible();
  await expect(box).toHaveValue("ring the plumb");
  await expect(box).toBeFocused();
});

test("an open sheet stays open while the task updates underneath it", async ({
  page,
  signIn,
  alexApi,
}) => {
  const { task } = await alexApi.post("/api/tasks", { title: "Get the pool fence repaired" });
  await signIn(page, "alex");
  await page.goto(`/tasks/${task.id}`);
  await page.locator("summary", { hasText: "Hand off" }).click();
  await page.locator("form[action$=handoff]").getByLabel("Next action").fill("Ring Poolsafe");

  await alexApi.post(`/api/tasks/${task.id}/checkpoint`, {
    note: "Poolsafe can come Thursday",
    next_actor: "me",
  });

  await expect(page.locator("[data-history]")).toContainText("Poolsafe can come Thursday");
  await expect(page.locator("form[action$=handoff]").getByLabel("Next action")).toHaveValue(
    "Ring Poolsafe",
  );
});

test("a task handed over from another phone arrives on the other person's Now", async ({
  page,
  signIn,
  phone,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", { title: "Choose paint for the hallway" });
  const sam = await phone("sam");
  await expect(nowRow(sam, "Choose paint for the hallway")).toHaveCount(0);

  await signIn(page, "alex");
  await nowRow(page, "Choose paint for the hallway").getByRole("link").click();
  await page.locator("summary", { hasText: "Hand off" }).click();
  await page.getByRole("combobox", { name: "To" }).selectOption("sam");
  await page.getByRole("button", { name: "Hand off", exact: true }).click();

  await expect(nowRow(sam, "Choose paint for the hallway")).toBeVisible();
});
