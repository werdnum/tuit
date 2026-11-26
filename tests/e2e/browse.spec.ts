import { expect, nowRow, rows, test } from "./fixtures.ts";

test("Tasks tab browses all tasks regardless of assignee or hidden area, with area, state and search filters", async ({
  page,
  signIn,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", { title: "Review PR", area: "tuit" });
  await alexApi.post("/api/tasks", {
    title: "Bump openssl",
    area: "security",
    next_actor: "agent:claude",
  });
  await alexApi.post("/api/tasks", {
    title: "Choose hallway paint",
    area: "home",
    next_actor: "sam",
  });
  const wait = (await alexApi.post("/api/tasks", { title: "Plumber quote", area: "home" })).task;
  await alexApi.post(`/api/tasks/${wait.id}/checkpoint`, {
    note: "Emailed plumber",
    next_actor: "me",
    waiting: { kind: "reply", for: "quote", follow_up: "+5d" },
  });
  const done = (await alexApi.post("/api/tasks", { title: "Patch curl", area: "security" })).task;
  await alexApi.post(`/api/tasks/${done.id}/complete`, {});
  await alexApi.post("/api/tasks", { title: "Untagged errand", next_actor: "sam" });
  await alexApi.patch("/api/areas/security", { hidden_by_default: true });

  await signIn(page, "alex");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tasks" }).click();
  await expect(page).toHaveURL(/\/tasks$/);

  const taskRows = rows(page, "Tasks");
  await expect(taskRows).toHaveCount(5);
  await expect(taskRows.filter({ hasText: "Bump openssl" })).toContainText("next: agent:claude");
  await expect(taskRows.filter({ hasText: "Choose hallway paint" })).toContainText("next: Sam");
  await expect(taskRows.filter({ hasText: "Plumber quote" })).toContainText("waiting");
  await expect(taskRows.filter({ hasText: "Patch curl" })).toHaveCount(0);

  // Filter by hidden area #security -> shows agent's task.
  await page
    .getByRole("navigation", { name: "Areas" })
    .getByRole("link", { name: "#security" })
    .click();
  await expect(page).toHaveURL(/\/tasks\?area=security$/);
  await expect(rows(page, "Tasks")).toHaveCount(1);
  await expect(rows(page, "Tasks").filter({ hasText: "Bump openssl" })).toBeVisible();

  // Switch state to Closed while staying in #security -> shows completed task.
  await page
    .getByRole("navigation", { name: "State" })
    .getByRole("link", { name: "Closed" })
    .click();
  await expect(rows(page, "Tasks")).toHaveCount(1);
  await expect(rows(page, "Tasks").filter({ hasText: "Patch curl" })).toBeVisible();

  // Switch to All in #security -> shows both active and closed.
  await page.getByRole("navigation", { name: "State" }).getByRole("link", { name: "All" }).click();
  await expect(rows(page, "Tasks")).toHaveCount(2);

  // Filter to No area in Active state.
  await page
    .getByRole("navigation", { name: "State" })
    .getByRole("link", { name: "Active" })
    .click();
  await page
    .getByRole("navigation", { name: "Areas" })
    .getByRole("link", { name: "No area" })
    .click();
  await expect(rows(page, "Tasks")).toHaveCount(1);
  await expect(rows(page, "Tasks").filter({ hasText: "Untagged errand" })).toBeVisible();

  // Explicitly selected Active state persists across area switches and search.
  await page
    .getByRole("navigation", { name: "Areas" })
    .getByRole("link", { name: "#security" })
    .click();
  await expect(page).toHaveURL(/state=active/);
  await page.getByRole("searchbox", { name: "Search" }).fill("curl");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("main")).toContainText('Nothing matches "curl"');

  // Fresh /tasks search without an explicit state includes closed tasks too.
  await page.goto("/tasks?area=home");
  await page.getByRole("searchbox", { name: "Search" }).fill("paint");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(rows(page, "Results")).toHaveCount(1);
  await expect(rows(page, "Results").filter({ hasText: "Choose hallway paint" })).toBeVisible();
});

test("clicking an area chip on Now links straight to all tasks in that area, including when none are mine", async ({
  page,
  signIn,
  alexApi,
}) => {
  const mine = (await alexApi.post("/api/tasks", { title: "My security review", area: "security" }))
    .task;
  await alexApi.post("/api/tasks", {
    title: "Agent CVE scan",
    area: "security",
    next_actor: "agent:claude",
  });
  await alexApi.post("/api/tasks", {
    title: "Sam cert check",
    area: "security",
    next_actor: "sam",
  });
  await alexApi.post("/api/tasks", {
    title: "Cluster upgrade",
    area: "cluster",
    next_actor: "agent:claude",
  });

  await signIn(page, "alex");

  // Area with both my tasks and others' tasks.
  await page
    .getByRole("navigation", { name: "Areas" })
    .getByRole("link", { name: "#security" })
    .click();
  await expect(nowRow(page, "My security review")).toBeVisible();
  await expect(nowRow(page, "Agent CVE scan")).toHaveCount(0);
  const browseLink = page.locator("[data-browse-area]");
  await expect(browseLink).toContainText("2 more in #security");
  await browseLink.click();
  await expect(page).toHaveURL(/\/tasks\?area=security$/);
  await expect(rows(page, "Tasks")).toHaveCount(3);
  await expect(rows(page, "Tasks").filter({ hasText: "Agent CVE scan" })).toBeVisible();
  await expect(rows(page, "Tasks").filter({ hasText: "Sam cert check" })).toBeVisible();

  // Area with zero tasks assigned to me: empty state still bridges directly to browse all.
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Areas" })
    .getByRole("link", { name: "#cluster" })
    .click();
  await expect(page.locator("[data-empty]")).toContainText("1 other active task in #cluster");
  await page.locator("[data-browse-area]").click();
  await expect(page).toHaveURL(/\/tasks\?area=cluster$/);
  await expect(rows(page, "Tasks").filter({ hasText: "Cluster upgrade" })).toBeVisible();

  // Clicking the area badge on a task detail page also browses all tasks in that area.
  await page.goto(`/tasks/${mine.id}`);
  await page.locator("a.badge.area").click();
  await expect(page).toHaveURL(/\/tasks\?area=security$/);
  await expect(rows(page, "Tasks")).toHaveCount(3);
});

test("Everything open includes hidden-by-default areas and filters by area", async ({
  page,
  signIn,
  alexApi,
}) => {
  await alexApi.post("/api/tasks", {
    title: "Bump openssl",
    area: "security",
    next_actor: "agent:claude",
  });
  await alexApi.post("/api/tasks", { title: "Mow the lawn", area: "home" });
  await alexApi.patch("/api/areas/security", { hidden_by_default: true });

  await signIn(page, "alex");
  await page.goto("/queues/open");

  const openRows = rows(page, "Everything open");
  await expect(openRows).toHaveCount(2);
  await expect(openRows.filter({ hasText: "Bump openssl" })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Areas" })
    .getByRole("link", { name: "#security" })
    .click();
  await expect(page).toHaveURL(/\/queues\/open\?area=security$/);
  await expect(rows(page, "Everything open")).toHaveCount(1);
  await expect(rows(page, "Everything open").filter({ hasText: "Bump openssl" })).toBeVisible();
});
