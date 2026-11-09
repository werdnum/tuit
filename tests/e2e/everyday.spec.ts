import { expect, nowRow, test } from "./fixtures.ts";

test("a title-only task captured on the phone appears in Now", async ({ page, signIn }) => {
  await signIn(page, "alex");

  await page
    .getByRole("textbox", { name: "Capture a task" })
    .fill("ring the vet about Milo's teeth");
  await page.keyboard.press("Enter");

  await expect(nowRow(page, "ring the vet about Milo's teeth")).toBeVisible();
});

test("rapid captures typed one after another are all kept", async ({ page, signIn, alexApi }) => {
  await signIn(page, "alex");
  const box = page.getByRole("textbox", { name: "Capture a task" });
  const titles = [
    "buy milk",
    "call mum",
    "renew rego",
    "book flights",
    "fix the tap",
    "water plants",
  ];

  for (const t of titles) {
    await box.pressSequentially(t);
    await box.press("Enter");
  }

  for (const t of titles) await expect(nowRow(page, t)).toBeVisible();
  const all = await alexApi.get("/api/tasks");
  expect(all.tasks.map((x: { title: string }) => x.title).sort()).toEqual([...titles].sort());
});

test("a note added to a task shows in its history", async ({ page, signIn, alexApi }) => {
  const { task } = await alexApi.post("/api/tasks", { title: "Get the pool fence repaired" });
  await signIn(page, "alex");
  await nowRow(page, "Get the pool fence repaired").getByRole("link").click();

  await page.getByRole("textbox", { name: "Note" }).fill("Poolsafe can come Thursday");
  await page.getByRole("button", { name: "Add note" }).click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
  await expect(page.locator("[data-history]")).toContainText("Poolsafe can come Thursday");
});

test("handing a task to Sam moves it from Alex's Now to Sam's", async ({
  page,
  signIn,
  phone,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", { title: "Choose paint for the hallway" });
  await signIn(page, "alex");
  await nowRow(page, "Choose paint for the hallway").getByRole("link").click();

  await page.locator("summary", { hasText: "Hand off" }).click();
  await page.getByRole("combobox", { name: "To" }).selectOption("sam");
  await page
    .locator("form[action$=handoff]")
    .getByLabel("Next action")
    .fill("Decide: sage or cream");
  await page.getByRole("button", { name: "Hand off", exact: true }).click();

  await expect(page.locator("[data-next]")).toContainText("Next: Sam — Decide: sage or cream");
  await page.goto("/");
  await expect(nowRow(page, "Choose paint for the hallway")).toHaveCount(0);
  const sam = await phone("sam");
  await expect(nowRow(sam, "Choose paint for the hallway")).toBeVisible();
});

test("handing off offers the agents that have tokens, and still takes another by name", async ({
  page,
  signIn,
  server,
  alexApi,
}) => {
  await server.api("sam", "family-assistant");
  const { task } = await alexApi.post("/api/tasks", { title: "Book the car service" });
  await signIn(page, "alex");
  await page.goto(`/tasks/${task.id}`);

  await page.locator("summary", { hasText: "Hand off" }).click();
  const form = page.locator("form[action$=handoff]");
  const to = form.getByRole("combobox", { name: "To" });
  await expect(to.locator("option")).toContainText([
    "Agent: family-assistant",
    "Agent: setup",
    "Another agent…",
  ]);
  await expect(form.getByRole("textbox", { name: "Agent name" })).toBeHidden();
  await to.selectOption({ label: "Agent: family-assistant" });
  await form.getByLabel("Next action").fill("Find a Saturday slot");
  await form.getByRole("button", { name: "Hand off", exact: true }).click();
  await expect(page.locator("[data-next]")).toContainText("family-assistant");

  await page.locator("summary", { hasText: "Hand off" }).click();
  await to.selectOption({ label: "Another agent…" });
  await form.getByRole("textbox", { name: "Agent name" }).fill("garage-bot");
  await form.getByRole("button", { name: "Hand off", exact: true }).click();
  await expect(page.locator("[data-next]")).toContainText("garage-bot");
});

test("a brief saved on two devices at once shows the conflict without losing the edit", async ({
  page,
  signIn,
  phone,
  alexApi,
}) => {
  const { task } = await alexApi.post("/api/tasks", { title: "Organise the fence repair" });
  await signIn(page, "alex");
  const other = await phone("alex");
  await page.goto(`/tasks/${task.id}`);
  await other.goto(`/tasks/${task.id}`);
  await other.getByText("Edit brief").click();
  await other.getByRole("textbox", { name: "Brief" }).fill("Ring Poolsafe back on Tuesday");
  await page.getByText("Edit brief").click();
  await page.getByRole("textbox", { name: "Brief" }).fill("Quote from Poolsafe: $450");
  await page.getByRole("button", { name: "Save brief" }).click();
  await expect(page.locator("[data-brief]")).toHaveText("Quote from Poolsafe: $450");
  // The other phone's page updates live, but the editor it has open stays as it was.
  await expect(other.locator("[data-brief]")).toHaveText("Quote from Poolsafe: $450");

  await other.getByRole("button", { name: "Save brief" }).click();

  await expect(other.locator("[data-conflict]")).toBeVisible();
  await expect(other.locator("[data-current-brief]")).toHaveText("Quote from Poolsafe: $450");
  await expect(other.getByRole("textbox", { name: "Your version" })).toHaveValue(
    "Ring Poolsafe back on Tuesday",
  );
});

test("an unsaved brief edit survives adding a note", async ({ page, signIn, alexApi }) => {
  await alexApi.post("/api/tasks", { title: "Service the aircon", brief: "Last serviced 2024" });
  await signIn(page, "alex");
  await nowRow(page, "Service the aircon").getByRole("link").click();
  await page.getByText("Edit brief").click();
  await page
    .getByRole("textbox", { name: "Brief" })
    .fill("Last serviced 2024; Coolair quoted $180");

  await page.getByRole("textbox", { name: "Note" }).fill("Rang Coolair");
  await page.getByRole("button", { name: "Add note" }).click();

  await expect(page.locator("[data-history]")).toContainText("Rang Coolair");
  await expect(page.getByRole("textbox", { name: "Brief" })).toHaveValue(
    "Last serviced 2024; Coolair quoted $180",
  );
});

test("a long brief reads as Markdown with its detail collapsed", async ({
  page,
  signIn,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", {
    title: "File US taxes",
    brief: [
      "**With the accountant.** Waiting on their engagement letter.",
      "",
      "<details>",
      "<summary>Documents gathered</summary>",
      "",
      "- [x] W-2 from employer",
      "- [ ] 1099-INT from the bank",
      "",
      "</details>",
    ].join("\n"),
  });
  await signIn(page, "alex");
  await nowRow(page, "File US taxes").getByRole("link").click();

  const brief = page.locator("[data-brief]");
  await expect(brief.locator("strong")).toHaveText("With the accountant.");
  await expect(brief.getByText("W-2 from employer")).toBeHidden();

  await brief.getByText("Documents gathered").click();
  await expect(brief.getByText("W-2 from employer")).toBeVisible();
  await expect(brief.getByRole("checkbox")).toHaveCount(2);
});

test("a task can wait on another one, and each links to the other", async ({
  page,
  signIn,
  alexApi,
}) => {
  const blocker = (await alexApi.post("/api/tasks", { title: "Plan Jan 2–6" })).task;
  const { task } = await alexApi.post("/api/tasks", {
    title: "Book the Eurostar",
    brief: `Depends on the plan (${blocker.id}).`,
  });
  await signIn(page, "alex");
  await page.goto(`/tasks/${task.id}`);

  await expect(
    page.locator("[data-brief]").getByRole("link", { name: blocker.id }),
  ).toHaveAttribute("href", `/tasks/${blocker.id}`);
  await page.locator("summary", { hasText: "Waiting for…" }).click();
  await page.getByRole("combobox", { name: "Or another task" }).selectOption(blocker.id);
  await page.getByRole("button", { name: "Wait on that task" }).click();

  await expect(page.locator("[data-waiting]")).toContainText("Waiting on Plan Jan 2–6");
  await page.locator("[data-blocker]").click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${blocker.id}$`));
  await expect(page.locator("[data-blocks]")).toContainText("Waiting on this: Book the Eurostar");
});

test("a task broken into parts shows them, and leaves Now to them", async ({
  page,
  signIn,
  alexApi,
}) => {
  const { task } = await alexApi.post("/api/tasks", { title: "Europe trip booked" });
  await signIn(page, "alex");
  await page.goto(`/tasks/${task.id}`);

  await page.locator("summary", { hasText: "Break into parts" }).click();
  await page.getByRole("textbox", { name: "Part" }).fill("book the Eurostar");
  await page.getByRole("button", { name: "Add part" }).click();

  await expect(page.locator("[data-parts]")).toContainText("book the Eurostar");
  await expect(page.locator("[data-done]")).toContainText("Its 1 open part");

  await page.goto("/");
  const row = nowRow(page, "book the Eurostar");
  await expect(row).toContainText("Part of Europe trip booked");
  await expect(page.locator(`main li[data-task="${task.id}"]`)).toHaveCount(0);

  await row.getByRole("link").click();
  await page.locator("[data-part-of]").getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
  await page.locator("[data-done]").getByRole("button", { name: "Done" }).click();
  await expect(
    page.locator("[data-parts] li").filter({ hasText: "book the Eurostar" }),
  ).toContainText("done");

  // Done earlier asks about open parts too.
  await page.getByRole("button", { name: "Reopen" }).click();
  await page.locator("[data-parts] li").getByRole("link", { name: "book the Eurostar" }).click();
  await page.getByRole("button", { name: "Reopen" }).click();
  await page.locator("[data-part-of]").getByRole("link").click();
  await page.locator("summary", { hasText: "Done earlier…" }).click();
  const earlier = page.locator("details", { hasText: "Or pick a date" });
  await earlier.getByRole("combobox", { name: "Its 1 open part" }).selectOption("detach");
  await earlier.getByLabel("Or pick a date").fill("2026-01-02");
  await earlier.getByRole("button", { name: "Record it" }).click();
  await expect(page.locator("[data-parts]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
  const parts = (await alexApi.get(`/api/tasks/${task.id}`)).parts;
  expect(parts).toEqual([]);
});
