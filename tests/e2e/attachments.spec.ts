import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const PICKER_ENV = {
  GOOGLE_PICKER_API_KEY: "test-api-key",
  GOOGLE_PICKER_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_PICKER_APP_ID: "123456",
  GOOGLE_PICKER_UPLOAD_FOLDER_ID: "household-folder",
};

/** Stand-ins for Google's sign-in and Picker scripts: sign-in succeeds, and the person picks one photo. */
const FAKE_GSI = `
window.google = window.google || {};
google.accounts = { oauth2: { initTokenClient: (cfg) => ({ requestAccessToken: () => {
  window.__tokenRequest = { client_id: cfg.client_id, scope: cfg.scope };
  setTimeout(() => cfg.callback({ access_token: "fake-drive-token", expires_in: 3599 }), 0);
} }) } };`;
const FAKE_PICKER = `
window.gapi = { load: (name, done) => {
  window.google = window.google || {};
  const calls = (window.__picker = {});
  const record = (m) => function (v) { (calls[m] = calls[m] || []).push(v); return this; };
  function DocsView() {}
  DocsView.prototype.setIncludeFolders = record("includeFolders");
  DocsView.prototype.setSelectFolderEnabled = record("selectFolder");
  function DocsUploadView() {}
  DocsUploadView.prototype.setParent = record("parent");
  function PickerBuilder() {}
  for (const m of ["addView", "enableFeature", "setOAuthToken", "setDeveloperKey", "setAppId", "setOrigin"])
    PickerBuilder.prototype[m] = record(m);
  PickerBuilder.prototype.setCallback = function (cb) { this.cb = cb; return this; };
  PickerBuilder.prototype.build = function () {
    const cb = this.cb;
    return { setVisible: () => setTimeout(() => cb({ action: "picked", docs: [
      { url: "https://drive.google.com/file/d/photo1/view", name: "Fence photo.jpg", mimeType: "image/jpeg" },
    ] }), 0) };
  };
  google.picker = { DocsView, DocsUploadView, PickerBuilder, ViewId: { DOCS: "all" },
    Feature: { MULTISELECT_ENABLED: "multi" }, Action: { PICKED: "picked" } };
  done();
} };`;

async function fakeGoogle(page: Page): Promise<void> {
  await page.route("https://accounts.google.com/gsi/client", (r) =>
    r.fulfill({ contentType: "text/javascript", body: FAKE_GSI }),
  );
  await page.route("https://apis.google.com/js/api.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: FAKE_PICKER }),
  );
}

test.describe("without Google Drive configured", () => {
  test("a pasted link is attached, opens in a new tab, and can be removed", async ({
    page,
    signIn,
    alexApi,
  }) => {
    const { task } = await alexApi.post("/api/tasks", { title: "Get the pool fence repaired" });
    await signIn(page, "alex");
    await page.goto(`/tasks/${task.id}`);

    await expect(page.getByRole("button", { name: /Google Drive/ })).toHaveCount(0);
    await page.locator("summary", { hasText: "Attach a file" }).click();
    await page
      .getByRole("textbox", { name: "Link" })
      .fill("https://drive.google.com/file/d/quote/view");
    await page.getByRole("textbox", { name: "Title (optional)" }).fill("Poolsafe quote");
    await page.getByRole("button", { name: "Attach link" }).click();

    const link = page.locator("[data-attachments]").getByRole("link", { name: /Poolsafe quote/ });
    await expect(link).toHaveAttribute("href", "https://drive.google.com/file/d/quote/view");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toContainText("Google Drive");
    await expect(page.locator("[data-history]")).toContainText("Attached Poolsafe quote");

    await page.getByRole("button", { name: "Remove Poolsafe quote" }).click();

    await expect(page.locator("[data-attachments]")).toHaveCount(0);
    await expect(page.locator("[data-history]")).toContainText("Removed attachment Poolsafe quote");
  });

  test("something that isn't a link is refused with a message", async ({
    page,
    signIn,
    alexApi,
  }) => {
    const { task } = await alexApi.post("/api/tasks", { title: "Get the pool fence repaired" });
    await signIn(page, "alex");
    await page.goto(`/tasks/${task.id}`);

    await page.locator("summary", { hasText: "Attach a file" }).click();
    // The field's own URL check would stop the browser before the server sees it.
    await page.getByRole("textbox", { name: "Link" }).evaluate((el) => {
      (el as HTMLInputElement).type = "text";
    });
    await page.getByRole("textbox", { name: "Link" }).fill("javascript:alert(1)");
    await page.getByRole("button", { name: "Attach link" }).click();

    await expect(page.getByRole("alert")).toContainText("http(s)");
    await expect(page.locator("[data-attachments]")).toHaveCount(0);
  });
});

test.describe("with Google Drive configured", () => {
  test.use({ serverEnv: PICKER_ENV });

  test("a file chosen in the Drive picker is attached to the task", async ({
    page,
    signIn,
    alexApi,
  }) => {
    const { task } = await alexApi.post("/api/tasks", { title: "Get the pool fence repaired" });
    await fakeGoogle(page);
    await signIn(page, "alex");
    await page.goto(`/tasks/${task.id}`);

    await page.locator("summary", { hasText: "Attach a file" }).click();
    // Opening the sheet starts loading Google's scripts, so the tap can open sign-in directly.
    await page.waitForFunction(() => {
      const g = (window as unknown as { google?: { picker?: unknown; accounts?: unknown } }).google;
      return !!(g?.picker && g.accounts);
    });
    await page.getByRole("button", { name: "Choose or upload from Google Drive" }).click();

    const link = page.locator("[data-attachments]").getByRole("link", { name: /Fence photo\.jpg/ });
    await expect(link).toHaveAttribute("href", "https://drive.google.com/file/d/photo1/view");
    const seen = await page.evaluate(() => {
      const w = window as unknown as { __tokenRequest: unknown; __picker: Record<string, unknown> };
      return { token: w.__tokenRequest, picker: w.__picker };
    });
    expect(seen.token).toEqual({
      client_id: PICKER_ENV.GOOGLE_PICKER_CLIENT_ID,
      scope: "https://www.googleapis.com/auth/drive.file",
    });
    expect(seen.picker).toMatchObject({
      setOAuthToken: ["fake-drive-token"],
      setDeveloperKey: [PICKER_ENV.GOOGLE_PICKER_API_KEY],
      setAppId: [PICKER_ENV.GOOGLE_PICKER_APP_ID],
      parent: [PICKER_ENV.GOOGLE_PICKER_UPLOAD_FOLDER_ID],
    });
    const { task: stored } = await alexApi.get(`/api/tasks/${task.id}`);
    expect(stored.attachments).toEqual([
      expect.objectContaining({ title: "Fence photo.jpg", mime_type: "image/jpeg" }),
    ]);
  });
});
