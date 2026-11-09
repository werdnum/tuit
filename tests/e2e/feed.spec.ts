import { expect, test } from "./fixtures.ts";

test("the feed shows what others did, and a new change arrives without a refresh", async ({
  page,
  signIn,
  server,
}) => {
  const alex = await server.human("alex");
  const { task } = await alex.post("/api/tasks", { title: "Get the gutters cleaned" });
  const sam = await server.human("sam");
  await signIn(page, "alex");
  await page.getByRole("link", { name: "Feed" }).click();
  const feed = page.locator("[data-feed]");
  await expect(feed).toContainText("Get the gutters cleaned");
  await expect(feed.locator("li").first()).toContainText("Captured");

  await sam.post(`/api/tasks/${task.id}/checkpoint`, {
    note: "Rang three people; Jim can come Friday",
    next_actor: "me",
  });

  await expect(feed.locator("li").first()).toContainText("Jim can come Friday");
  await expect(feed.locator("li").first()).toContainText("Sam");

  await page.getByRole("link", { name: "Not me" }).click();
  await expect(feed).toContainText("Jim can come Friday");
  await expect(feed).not.toContainText("Captured");
});

test("Sam's feed never shows Alex's private task", async ({ signIn, page, phone, alexApi }) => {
  await alexApi.post("/api/tasks", { title: "Sam birthday: ring size", visibility: "private" });
  await alexApi.post("/api/tasks", { title: "Buy milk" });
  await signIn(page, "alex");
  await page.goto("/feed");
  await expect(page.locator("[data-feed]")).toContainText("ring size");

  const sam = await phone("sam");
  await sam.goto("/feed");

  await expect(sam.locator("[data-feed]")).toContainText("Buy milk");
  await expect(sam.locator("body")).not.toContainText("ring size");
});
