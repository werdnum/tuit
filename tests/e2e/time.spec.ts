import { expect, nowRow, rows, test } from "./fixtures.ts";

test("a task with notes expires without being done and can still be found", async ({
  page,
  server,
  signIn,
  alexApi,
}) => {
  const { task } = await alexApi.post("/api/tasks", {
    title: "Check in for the Melbourne flight",
  });
  await signIn(page, "alex");
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole("textbox", { name: "Note" }).fill("Qantas check-in opens 24h before");
  await page.getByRole("button", { name: "Add note" }).click();
  await page.locator("summary", { hasText: "More" }).click();
  await page.getByLabel("Expires (irrelevant after)").fill("2026-10-07 07:15");
  await page.getByRole("button", { name: "Save dates" }).click();
  await expect(page.locator("[data-moment=expires]")).toContainText("7:15am");

  await server.setClock("2026-10-07T08:00:00+11:00");

  await page.goto("/");
  await expect(nowRow(page, "Check in for the Melbourne flight")).toHaveCount(0);
  await page.goto("/search?q=melbourne");
  const result = rows(page, "Results").filter({ hasText: "Check in for the Melbourne flight" });
  await expect(result.locator(".badge")).toHaveText("expired");
  await result.getByRole("link").click();
  await expect(page.locator("[data-history]")).toContainText("Qantas check-in opens 24h before");
});

test("a routine done yesterday comes back as one item after two months away", async ({
  page,
  server,
  signIn,
  alexApi,
}) => {
  const { task } = await alexApi.post("/api/tasks", { title: "Clean the coffee machine" });
  await signIn(page, "alex");
  await page.goto(`/tasks/${task.id}`);
  await page.locator("summary", { hasText: "More" }).click();
  await page.getByRole("combobox", { name: "Repeats" }).selectOption("after_completion");
  await page.getByRole("spinbutton", { name: "N days" }).fill("14");
  await page.getByRole("button", { name: "Save routine" }).click();
  await page.locator("summary", { hasText: "Did it earlier…" }).click();
  await page.getByRole("button", { name: "Yesterday" }).click();
  await expect(page.locator("[data-routine]")).toHaveText("last done yesterday · every 14 days");

  await server.setClock("2026-12-04T09:00:00+11:00");
  await page.goto("/");

  const items = nowRow(page, "Clean the coffee machine");
  await expect(items).toHaveCount(1);
  await expect(items).toContainText("last done 61 days ago");
});

test("finishing shortlist items leaves them ticked and Enough for now keeps urgent work visible", async ({
  page,
  signIn,
  alexApi,
}) => {
  for (let i = 1; i <= 7; i++) await alexApi.post("/api/tasks", { title: `Chore ${i}` });
  await alexApi.post("/api/tasks", { title: "Lodge the rego renewal", deadline: "tomorrow" });
  await signIn(page, "alex");
  const today = rows(page, "Today");
  const planned = await today.locator(".row-title").allInnerTexts();

  await today
    .nth(0)
    .getByRole("button", { name: /^Done:/ })
    .click();
  await expect(today.nth(0)).toHaveClass(/done/);
  await today
    .nth(1)
    .getByRole("button", { name: /^Done:/ })
    .click();
  await expect(today.nth(1)).toHaveClass(/done/);

  expect(await today.locator(".row-title").allInnerTexts()).toEqual(planned);
  await expect(rows(page, "New since this morning")).toHaveCount(0);
  await page.getByRole("button", { name: "Enough for now" }).click();
  await expect(page.locator("[data-enough]")).toBeVisible();
  await expect(today).toHaveCount(0);
  await expect(rows(page, "Urgent").filter({ hasText: "Lodge the rego renewal" })).toBeVisible();
});

test("after a month away Now is short, shows the commitment as urgent and has dropped expired things", async ({
  page,
  server,
  signIn,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", { title: "Return the library books", expires: "2026-10-15" });
  await alexApi.post("/api/tasks", {
    title: "Submit the council permit",
    deadline: "2026-11-05",
    next_actor: "sam",
  });
  await alexApi.post("/api/tasks", {
    title: "Water the plants",
    recurrence: { mode: "after_completion", every_days: 7 },
    last_done: "yesterday",
  });
  for (let i = 1; i <= 8; i++) await alexApi.post("/api/tasks", { title: `Odd job ${i}` });
  await signIn(page, "alex");

  await server.setClock("2026-11-04T09:00:00+11:00");
  await page.goto("/");

  await expect(page.locator("[data-away]")).toContainText("1 expired");
  expect(await rows(page, "Today").count()).toBeLessThanOrEqual(5);
  await expect(rows(page, "Urgent").filter({ hasText: "Submit the council permit" })).toBeVisible();
  await expect(nowRow(page, "Return the library books")).toHaveCount(0);
  await expect(nowRow(page, "Water the plants")).toHaveCount(1);
});
