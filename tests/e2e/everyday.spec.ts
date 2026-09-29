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
