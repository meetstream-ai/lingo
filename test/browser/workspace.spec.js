import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createApp } from "../../server/app.js";

test("complete accessible sample: captions, language switch, post-call, review, search and all exports", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "Every voice, understood." }),
  ).toBeVisible();
  let a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({
    path: "test-results/workspace-empty.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /Try the sample/ }).click();
  await expect(page.locator("#caption-original")).toContainText("नमस्ते", {
    timeout: 5000,
  });
  await expect(page.locator("#caption-translated")).toContainText(
    "Hello everyone",
  );
  await expect(page.locator("#sample-notice")).toBeVisible();
  await page.getByLabel("Translate to", { exact: true }).selectOption("hi");
  await expect(page.locator("#caption-translated")).toContainText("नमस्ते");
  await page.getByLabel("Translate to", { exact: true }).selectOption("en");
  await page.getByRole("button", { name: "Pause display" }).click();
  const original = await page.locator("#caption-original").textContent();
  await expect(page.locator("#turn-count")).toHaveText("2 turns", {
    timeout: 5000,
  });
  expect(await page.locator("#caption-original").textContent()).toEqual(
    original,
  );
  await page.getByRole("button", { name: "Resume display" }).click();
  await page.getByLabel("Text size", { exact: true }).selectOption("38");
  await page.getByRole("button", { name: "High contrast" }).click();
  expect(await page.locator("body").getAttribute("class")).toContain(
    "high-contrast",
  );
  a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.getByRole("button", { name: "High contrast" }).click();
  await page.getByLabel("Text size", { exact: true }).selectOption("30");
  await expect(page.locator("#session-status")).toHaveText("Completed", {
    timeout: 20000,
  });
  await expect(page.locator("#turn-count")).toHaveText("8 turns");
  await page.getByRole("button", { name: "Post-call", exact: true }).click();
  await expect(page.locator("#turn-count")).toHaveText("8 turns");
  await expect(page.locator("#transcript-description")).toContainText("ready");
  await page.getByLabel("Search transcript").fill("Karthik");
  await expect(page.locator("#turn-count")).toHaveText("4 turns");
  await page.getByLabel("Search transcript").fill("nothing-matches");
  await expect(
    page.getByText("No matching turns. Try another word."),
  ).toBeVisible();
  await page.getByLabel("Search transcript").fill("");
  await page.locator("[data-review]").first().click();
  await page.getByLabel("Quality score").selectOption("4");
  await page
    .getByLabel("Review notes")
    .fill("Review of sample wording; not a real provider result.");
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page.locator("[data-review]").first()).toContainText(
    "Reviewed 4/5",
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/workspace-captions.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Export & share" }).click();
  a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Share to Slack" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save to Google Drive" }),
  ).toBeDisabled();
  for (const format of ["vtt", "srt", "html", "md", "json"]) {
    await page
      .getByRole("combobox", { name: "Format", exact: true })
      .selectOption(format);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const result = await download;
    expect(result.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
    expect(await result.failure()).toBeNull();
  }
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Meeting health", exact: true }).click();
  await page.getByText("Technical details",{exact:true}).click();
  await expect(
    page.getByText("Hindi → English", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Tamil → Hindi", { exact: true })).toBeVisible();
  await expect(page.getByText("4 (1 reviews)", { exact: true })).toBeVisible();
  const evidence = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download technical report" }).click();
  expect((await evidence).suggestedFilename()).toMatch(/_\d{2}-\d{2}-\d{4}_[A-Za-z]+_\d{2}-\d{2}-\d{2}_IST_.*-measurements\.json$/);
  await expect(
    page.getByText(/not the whole delay/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Google Cloud Translation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await page.getByRole("button", { name: "Open meeting" }).first().click();
  await expect(page.locator("#session-title")).toHaveText(
    "A more accessible team sync",
  );
  expect(errors).toEqual([]);
});
test("mobile layout, keyboard dialog flow and live setup validation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workspace");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to meeting workspace" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await page.getByRole("button", { name: "New meeting", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Meeting title").fill("Mobile meeting");
  await page.getByLabel("Real meeting").check();
  await page
    .getByLabel("Meeting URL")
    .fill("https://meet.google.com/abc-defg-hij");
  await page.getByRole("button", { name: "Join meeting", exact: true }).click();
  await expect(page.locator("#new-error")).toContainText(
    "Choose available speech and translation providers",
  );
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
});

test("dropdown spacing stays consistent across dialogs and narrow caption layouts; streaming preserves keyboard focus", async ({
  page,
}) => {
  await page.goto("/workspace");
  await page.getByRole("button", { name: /Try the sample/ }).click();
  await expect(page.locator("[data-review]").first()).toBeVisible();
  const firstCue = await page
    .locator("[data-review]")
    .first()
    .getAttribute("data-review");
  await page.locator(`[data-review="${firstCue}"]`).focus();
  await expect(page.locator("#turn-count")).toHaveText("2 turns", {
    timeout: 5000,
  });
  await expect(page.locator(`[data-review="${firstCue}"]`)).toBeFocused();
  await page.locator(`[data-review="${firstCue}"]`).click();
  await page.getByLabel("Review notes").fill("Keyboard focus regression check");
  await expect(page.locator("#turn-count")).toHaveText("3 turns", {
    timeout: 5000,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(`[data-review="${firstCue}"]`)).toBeFocused();
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const spacing = await page
      .locator("select:visible")
      .evaluateAll((selects) =>
        selects.map((select) => {
          const style = getComputedStyle(select);
          return {
            appearance: style.appearance,
            right: style.paddingRight,
            arrow: style.backgroundPosition,
            size: style.backgroundSize,
          };
        }),
      );
    for (const style of spacing) {
      expect(style.appearance).toBe("none");
      expect(style.right).toBe("36px");
      expect(style.arrow).toBe(spacing[0].arrow);
      expect(style.size).toBe("12px 12px");
    }
  }
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({
    path: "test-results/workspace-mobile-captions.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "New meeting", exact: true }).click();
  await page.getByLabel("Real meeting").check();
  for (const select of await page.locator("dialog[open] select").all()) {
    expect(
      await select.evaluate((el) => getComputedStyle(el).paddingRight),
    ).toBe("36px");
    expect(
      await select.evaluate((el) => getComputedStyle(el).backgroundSize),
    ).toBe("12px 12px");
  }
  await page.screenshot({
    path: "test-results/workspace-mobile-dialog.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.emulateMedia({ forcedColors: "active" });
  expect(
    await page
      .locator("#viewer-language")
      .evaluate((el) => getComputedStyle(el).appearance),
  ).toBe("auto");
  await page.emulateMedia({ forcedColors: "none" });
});

test("private workspace sign-in, sign-out and expired-session recovery preserve meetings", async ({
  page,
  context,
}) => {
  const kit = createApp({
    env: {
      APP_PASSWORD: "browser-test-password",
      SESSION_SECRET: "browser-test-session-secret",
    },
    database: ":memory:",
  });
  const server = kit.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(`${base}/workspace`);
    await expect(page.locator("#login-dialog")).toBeVisible();
    const field = await page.getByLabel("Workspace password").boundingBox();
    const button = await page
      .getByRole("button", { name: "Sign in", exact: true })
      .boundingBox();
    expect(button.y - field.y - field.height).toBeGreaterThanOrEqual(24);
    await page.screenshot({ path: "test-results/workspace-login.png" });
    let a11y = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(a11y.violations).toEqual([]);
    await page.getByLabel("Workspace password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#login-error")).toContainText(
      "Incorrect workspace password",
    );
    await page.getByLabel("Workspace password").fill("browser-test-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#login-dialog")).not.toBeVisible();
    await page
      .getByRole("button", { name: "New meeting", exact: true })
      .click();
    await page.getByLabel("Meeting title").fill("Private sample");
    await expect(page.locator("#target-options input")).toHaveCount(Object.keys((await (await page.request.get(`${base}/api/config`)).json()).languages).length);
    await page
      .getByRole("button", { name: "Start sample", exact: true })
      .click();
    await expect(page.locator("#caption-original")).toContainText("नमस्ते");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("#login-dialog")).toBeVisible();
    expect((await page.request.get(base + "/api/meetings")).status()).toBe(401);
    await page.getByLabel("Workspace password").fill("browser-test-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#session-title")).toHaveText("Private sample");
    await context.clearCookies();
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(page.locator("#login-dialog")).toBeVisible();
    await page.getByLabel("Workspace password").fill("browser-test-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#login-dialog")).not.toBeVisible();
    await page
      .getByRole("button", { name: "New meeting", exact: true })
      .click();
    await expect(page.locator("#target-options input")).toHaveCount(Object.keys((await (await page.request.get(`${base}/api/config`)).json()).languages).length);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Captions", exact: true }).click();
    await expect(page.locator("#session-title")).toHaveText("Private sample");
  } finally {
    await kit.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("profile persists reading preferences and form spacing uses one grid gap", async ({
  page,
}) => {
  await page.goto("/workspace");
  await page
    .getByRole("button", { name: "Profile and reading preferences" })
    .click();
  await page.getByLabel("Display name").fill("Arjun Reader");
  await page.getByLabel("Preferred caption language").selectOption("hi");
  await page.getByLabel("Default text size").selectOption("38");
  await page.getByLabel("Use high contrast").check();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Save preferences" }).click();
  await page.reload();
  await expect(page.locator("#profile-initials")).toHaveText("AR");
  await expect(page.getByLabel("Text size", { exact: true })).toHaveValue("38");
  await expect(
    page.getByRole("button", { name: "High contrast", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Try the sample/ }).click();
  await expect(page.locator("#caption-original")).toContainText("नमस्ते");
  await expect(page.getByLabel("Translate to", { exact: true })).toHaveValue(
    "hi",
  );
  await page.getByRole("button", { name: "New meeting", exact: true }).click();
  await page.getByLabel("Real meeting").check();
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const grid = await page
      .locator("#live-fields .form-grid")
      .evaluate((el) => ({
        gap: getComputedStyle(el).rowGap,
        margins: [...el.children].map(
          (child) => getComputedStyle(child).marginTop,
        ),
      }));
    expect(grid).toEqual({ gap: "16px", margins: ["0px", "0px"] });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({ path: "test-results/workspace-live-setup.png" });
});

test("meeting routes preserve Back and Forward, deep-linked transcripts, search and pagination", async ({
  page,
}) => {
  const prefix = "History " + crypto.randomUUID().slice(0, 8);
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const response = await page.request.post("/api/meetings", {
      data: { title: `${prefix} ${i}`, mode: "demo", targets: ["en", "hi"] },
    });
    const m = await response.json();
    ids.push(m.id);
    await page.request.post(`/api/meetings/${m.id}/stop`);
  }
  await page.goto("/workspace");
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await page.getByLabel("Search meetings").fill(prefix);
  await page
    .locator("#meeting-search-form")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await expect(page.locator("#meeting-list .meeting-card")).toHaveCount(10);
  await expect(page.locator("#meeting-page")).toContainText("12 meetings");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#meeting-list .meeting-card")).toHaveCount(2);
  await expect(page).toHaveURL(/page=2/);
  await page.locator("#meeting-list [data-open-meeting]").first().click();
  await expect(page.locator("#view-captions")).toBeVisible();
  await expect(page).toHaveURL(/\/workspace\/meetings\/[^/?]+/);
  const selected = decodeURIComponent(new URL(page.url()).pathname.split("/")[3]);
  await page.goBack();
  await expect(page.locator("#view-sessions")).toBeVisible();
  await expect(page.locator("#meeting-page")).toContainText("Page 2");
  await page.goForward();
  await expect(page.locator("#view-captions")).toBeVisible();
  await expect(page.locator("#session-title")).toContainText(prefix);
  await page.getByRole("button", { name: "Post-call", exact: true }).click();
  await expect(page).toHaveURL(/kind=final/);
  await page.reload();
  await expect(page.locator("#show-final")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#session-title")).toContainText(prefix);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/connections/);
  await page.goBack();
  await expect(page.locator("#show-final")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(decodeURIComponent(new URL(page.url()).pathname.split("/")[3])).toBe(selected);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: "test-results/workspace-navigation.png",
    fullPage: true,
  });
});

test("portable saves include un-translated originals, complete archive and a readable print preview", async ({
  page,
}) => {
  await page.goto("/workspace");
  await page.getByRole("button", { name: /Try the sample/ }).click();
  await expect(page.locator("#caption-original")).toContainText("नमस्ते");
  const archiveEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save full archive", exact: true })
    .click();
  const archive = await archiveEvent;
  expect(archive.suggestedFilename()).toContain("archive.json");
  await page.getByRole("button", { name: "Export & share" }).click();
  await page.locator("#export-language").selectOption("original");
  await page.locator('#export-form select[name="format"]').selectOption("txt");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toContain("original.txt");
  const previewEvent = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Print / save PDF", exact: true })
    .click();
  const preview = await previewEvent;
  await expect(preview.getByRole("heading", { level: 1 })).toHaveText(
    "A more accessible team sync",
  );
  await expect(
    preview.getByText(
      "नमस्ते सभी को। आज हम अपनी बैठकों को अधिक सुलभ बनाने पर बात करेंगे।",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await preview
      .locator("body")
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("18px");
  await preview.close();
});

test("missing meeting links recover to the library without retaining a stale selection", async ({
  page,
}) => {
  await page.goto("/?meeting=missing-meeting&view=captions");
  await expect(page.locator("#view-sessions")).toBeVisible();
  await expect(page.locator("#toast")).toHaveText("Meeting not found.");
  await expect(page).not.toHaveURL(/meeting=missing/);
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  await expect(page.locator("#session-title")).toHaveText(
    "No meeting selected",
  );
  await expect(page.locator("#start-sample")).toBeVisible();
});

test("meeting title links open with browser history; notebook editing, action completion and notes downloads persist", async ({
  page,
}) => {
  await page.goto("/workspace");
  await page.getByRole("button", { name: /Try the sample/ }).click();
  await expect(page.locator("#caption-original")).toContainText("नमस्ते");
  const id = decodeURIComponent(new URL(page.url()).pathname.split("/")[3]);
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  const title = page.locator(`.meeting-title[data-open-meeting="${id}"]`);
  await expect(title).toHaveAttribute("href", new RegExp(id));
  await title.click();
  await expect(page.locator("#view-captions")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#view-sessions")).toBeVisible();
  await page.goForward();
  await page.getByRole("button", { name: "Edit details", exact: true }).click();
  const renamed = `Team decisions ${id.slice(0, 8)}`;
  await page.locator("#details-meeting-title").fill(renamed);
  await page
    .getByLabel("Meeting notes", { exact: true })
    .fill(
      "Publish the Hindi and Tamil transcripts. <script> stays plain text.",
    );
  await page
    .getByRole("button", { name: "Add action item", exact: true })
    .click();
  await page
    .getByLabel("Action description", { exact: true })
    .fill("Review Tamil translation");
  await page.getByLabel("Owner", { exact: true }).fill("Arjun");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(page.locator("#details-dialog")).not.toBeVisible();
  await expect(page.locator("#session-title")).toHaveText(renamed);
  await expect(page.locator("#notebook-notes")).toContainText(
    "<script> stays plain text.",
  );
  const action = page.locator("#notebook-actions input");
  await action.check();
  await expect(page.locator("#notebook-actions .action-done")).toHaveText(
    "Review Tamil translation",
  );
  await page.reload();
  await expect(page.locator("#notebook-actions input")).toBeChecked();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download notes", exact: true }).click();
  const notesFile = await downloadEvent;
  expect(notesFile.suggestedFilename()).toContain("notes.txt");
  expect(await notesFile.failure()).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: "test-results/workspace-notebook-mobile.png",
    fullPage: true,
  });
});

test("private browser connection forms keep stored secrets blank, save live settings and show managed Deepgram", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let usedKey;
  const kit = createApp({
    database: ":memory:",
    startWorker: false,
    env: {
      APP_PASSWORD: "connections-browser-password",
      GOOGLE_TRANSLATE_API_KEY: "previous-private-key",
    },
    fetchImpl: async (_url, options) => {
      usedKey = options.headers["X-Goog-Api-Key"];
      return Response.json({
        data: { translations: [{ translatedText: "Hello" }] },
      });
    },
  });
  const server = kit.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(`${base}/?view=settings`);
    await page
      .getByLabel("Workspace password")
      .fill("connections-browser-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#view-settings")).toBeVisible();
    const google = page.locator(".connection").filter({
      has: page.getByRole("heading", {
        name: "Google Cloud Translation",
        exact: true,
      }),
    });
    await google
      .getByRole("button", { name: "Configure", exact: true })
      .click();
    const key = page.locator("#connection-fields input");
    await expect(key).toHaveValue("");
    await expect(key).toHaveAttribute("type", "password");
    await key.fill("updated-private-key");
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await expect(page.locator("#connection-dialog")).not.toBeVisible();
    await google
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(google.locator(".status")).toHaveText("Test passed");
    expect(usedKey).toBe("updated-private-key");
    expect(
      await (await page.request.get(`${base}/api/config`)).text(),
    ).not.toContain("updated-private-key");
    await google
      .getByRole("button", { name: "Configure", exact: true })
      .click();
    await expect(page.locator("#connection-fields input")).toHaveValue("");
    await page
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await google
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(google.locator(".status")).toHaveText("Test passed");
    expect(usedKey).toBe("updated-private-key");
    const deepgram = page.locator(".connection").filter({
      has: page.getByRole("heading", { name: "Deepgram", exact: true }),
    });
    await expect(deepgram).toContainText("No separate Deepgram key is needed");
    await expect(
      deepgram.getByRole("link", { name: "Manage in MeetStream ↗" }),
    ).toHaveAttribute("href", "https://app.meetstream.ai/integrations");
    await deepgram
      .getByRole("button", { name: "Test saved audio", exact: true })
      .click();
    await expect(page.locator("#deepgram-submit")).toBeDisabled();
    await page.getByRole("button", { name: "Close Deepgram test" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: "test-results/workspace-connections-mobile.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await kit.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("meeting section navigation preserves library context, deep links, selected transcript and browser history", async ({
  page,
}) => {
  const prefix = `Section ${crypto.randomUUID().slice(0, 8)}`;
  for (let i = 0; i < 12; i++)
    await page.request.post("/api/meetings", {
      data: { mode: "demo", title: `${prefix} ${i}` },
    });
  await page.goto("/?view=sessions");
  await page.getByLabel("Search meetings").fill(prefix);
  await page
    .locator("#meeting-search-form")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await page.getByLabel("Status", { exact: true }).selectOption("active");
  await expect(page.locator("#meeting-page")).toContainText("12 meetings");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#meeting-list .meeting-card")).toHaveCount(2);
  await page.locator(".meeting-title").first().click();
  const sections = page.getByRole("navigation", { name: "Meeting sections" });
  await sections
    .getByRole("link", { name: "Notes & actions", exact: true })
    .click();
  await expect(page).toHaveURL(/\/notes(?:\?|$)/);
  await expect(page.locator("#announcer")).toHaveText("");
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  await expect(page.locator("#caption-panel")).toBeVisible();
  await sections
    .getByRole("link", { name: "Notes & actions", exact: true })
    .click();
  await expect(page.locator("#notebook-panel")).toBeVisible();
  await expect(page.locator("#caption-panel")).not.toBeVisible();
  await page.reload();
  await expect(page.locator("#notebook-panel")).toBeVisible();
  await sections.getByRole("link", { name: "Transcript", exact: true }).click();
  await page.getByRole("button", { name: "Post-call", exact: true }).click();
  await expect(page).toHaveURL(/kind=final/);
  await sections.getByRole("link", { name: "Recordings", exact: true }).click();
  await expect(page.locator("#recording-empty")).toContainText(
    "sample has no audio",
  );
  await page.goBack();
  await expect(page.locator("#transcript-panel")).toBeVisible();
  await expect(page.locator("#show-final")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page
    .getByRole("link", { name: "Back to meetings", exact: false })
    .click();
  await expect(page.locator("#view-sessions")).toBeVisible();
  await expect(page.locator("#meeting-page")).toContainText("Page 2");
  await expect(page.getByLabel("Search meetings")).toHaveValue(prefix);
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue(
    "active",
  );
  await page.goBack();
  await expect(page.locator("#transcript-panel")).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const navigation = page.getByRole("navigation", {
    name: "Workspace",
    exact: true,
  });
  await expect(
    navigation.getByRole("button", { name: "Meetings", exact: true }),
  ).toBeVisible();
  expect(await navigation.evaluate((e) => getComputedStyle(e).position)).toBe(
    "fixed",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: "test-results/workspace-sections-mobile.png",
    fullPage: true,
  });
});

test("finished meetings open the post-call workspace directly and section links can open in a new tab", async ({
  page,
}) => {
  const kit = createApp({ env: {}, database: ":memory:", startWorker: false });
  kit.store.saveMeeting({
    id: "finished-navigation",
    title: "Finished meeting navigation",
    status: "completed",
    endedAt: Date.now(),
    createdAt: Date.now(),
    postCallStatus: "ready",
    mode: "demo",
    targets: ["en"],
    source: "hi",
  });
  const server = kit.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(`${base}/?view=sessions`);
    await page
      .getByRole("link", { name: "Finished meeting navigation", exact: true })
      .click();
    await expect(page).toHaveURL(/\/transcript(?:\?|$)/);
    await expect(page.locator("#show-final")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const notes = page
      .getByRole("navigation", { name: "Meeting sections" })
      .getByRole("link", { name: "Notes & actions", exact: true });
    const href = await notes.getAttribute("href");
    const other = await page.context().newPage();
    await other.goto(href);
    await expect(other.locator("#notebook-panel")).toBeVisible();
    await expect(other.locator("#session-title")).toHaveText(
      "Finished meeting navigation",
    );
    await other.close();
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name: "Meetings", exact: true })
      .click();
    await expect(page.locator("#view-sessions")).toBeVisible();
  } finally {
    await kit.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
