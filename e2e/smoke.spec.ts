import { expect, test, type Page } from "@playwright/test";

// A throwaway test password; each test runs in a fresh browser profile.
const PASSWORD = "tram violet kettle ninety";

async function openTab(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
}

async function createVault(page: Page) {
  await openTab(page, "Authenticator");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByPlaceholder(/New password/).fill(PASSWORD);
  await page.getByPlaceholder("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set password & encrypt" }).click();
  await expect(page.getByText("Secrets are encrypted at rest.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Close dialog" }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("./");
});

test("every tool opens, including the lazily loaded ones", async ({ page }) => {
  for (const [tab, marker] of [
    ["YML-Validator", /Kubernetes manifest/],
    ["Grammar-Polisher", /./],
    ["JSON-Studio", /local only/],
    ["Diff-Checker", /Original/],
  ] as const) {
    await openTab(page, tab);
    await expect(page.locator("main")).toContainText(marker, { timeout: 30_000 });
  }
});

test("the master password policy blocks weak passwords", async ({ page }) => {
  await openTab(page, "Authenticator");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByPlaceholder(/New password/).fill("password1234");
  await page.getByPlaceholder("Confirm new password").fill("password1234");
  await expect(page.getByText(/one of the first words attackers try/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set password & encrypt" })).toBeDisabled();
});

test("vault: encrypt, add an account, lock, unlock", async ({ page }) => {
  await createVault(page);

  await page.getByRole("button", { name: "+ Add" }).click();
  await page.getByRole("button", { name: "Manual entry" }).click();
  await page.getByPlaceholder("GitHub").fill("E2E Issuer");
  await page.getByPlaceholder("user@example.com").fill("e2e@example.com");
  await page.getByPlaceholder("JBSW Y3DP EHPK 3PXP").fill("JBSWY3DPEHPK3PXP");
  await page.getByRole("button", { name: "Add account" }).last().click();
  await expect(page.getByText("E2E Issuer")).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy code \d{6}/ })).toBeVisible();

  // Names are sealed on disk (F-14): nothing identifying in IndexedDB.
  const stored = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const open = indexedDB.open("coretools-authenticator");
        open.onsuccess = () => {
          const read = open.result.transaction("entries").objectStore("entries").getAll();
          read.onsuccess = () => resolve(JSON.stringify(read.result));
        };
      }),
  );
  expect(stored).not.toContain("E2E Issuer");
  expect(stored).not.toContain("e2e@example.com");

  await page.getByRole("button", { name: /Lock/ }).first().click();
  await expect(page.getByText("Authenticator locked")).toBeVisible();
  await expect(page.getByText("E2E Issuer")).toHaveCount(0);

  await page.getByPlaceholder("Encryption password").fill("wrong password value");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Wrong password")).toBeVisible({ timeout: 20_000 });

  await page.getByPlaceholder("Encryption password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("E2E Issuer")).toBeVisible({ timeout: 20_000 });
});

test("credential manager: add, search, sealed at rest, audited", async ({ page }) => {
  await createVault(page);
  await openTab(page, "Credential-Manager");
  await page.getByRole("button", { name: "+ Add credential" }).click();
  await page.getByPlaceholder("AWS Production").fill("E2E Console");
  await page.getByPlaceholder("devops-admin").fill("e2e-user");
  await page.getByRole("button", { name: "Generate" }).click();
  await page.getByRole("button", { name: "Add credential" }).last().click();
  await expect(page.getByText("E2E Console")).toBeVisible();

  await page.getByPlaceholder(/Search platform/).fill("nothing-matches-this");
  await expect(page.getByText("E2E Console")).toHaveCount(0);
  await page.getByPlaceholder(/Search platform/).fill("e2e");
  await expect(page.getByText("E2E Console")).toBeVisible();

  await page.getByRole("button", { name: "Activity log" }).click();
  await expect(page.getByText(/Integrity verified/)).toBeVisible();
});

test("credential manager: spaces split the list; All keeps every login", async ({ page }) => {
  await createVault(page);
  await openTab(page, "Credential-Manager");
  await page.getByRole("button", { name: "+ Add credential" }).click();
  await page.getByPlaceholder("AWS Production").fill("E2E Bank");
  await page.getByRole("button", { name: "Add credential" }).last().click();
  await expect(page.getByText("E2E Bank")).toBeVisible();

  // A new space opens empty; adding from it files the login there.
  await page.getByRole("button", { name: "+ New space" }).click();
  await page.getByLabel("Space name").fill("Dev team");
  await page.getByRole("button", { name: "Create space" }).click();
  await expect(page.getByRole("tab", { name: "Dev team, 0 logins" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "+ Add credential" }).first().click();
  await page.getByPlaceholder("AWS Production").fill("E2E GitHub");
  await page.getByRole("button", { name: "Add credential" }).last().click();
  await expect(page.getByText("E2E GitHub")).toBeVisible();
  await expect(page.getByText("E2E Bank")).toHaveCount(0);

  await page.getByRole("tab", { name: "All, 2 logins" }).click();
  await expect(page.getByText("E2E Bank")).toBeVisible();
  await expect(page.getByText("E2E GitHub")).toBeVisible();
});

test("credential manager: All can be hidden once every login is in a space", async ({ page }) => {
  await createVault(page);
  await openTab(page, "Credential-Manager");
  await page.getByRole("button", { name: "+ Add credential" }).click();
  await page.getByPlaceholder("AWS Production").fill("E2E Work login");
  await page.getByLabel("Space", { exact: true }).selectOption({ label: "New space…" });
  await page.getByLabel("Space", { exact: true }).fill("Work");
  await page.getByRole("button", { name: "Add credential" }).last().click();

  const showAll = page.getByRole("switch", { name: "Show All" });
  await expect(showAll).toBeChecked();
  await showAll.uncheck();
  await expect(page.getByRole("tab", { name: /^All,/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Work, 1 login" })).toHaveAttribute("aria-selected", "true");

  // A login without a space brings All back, so it can't become unreachable.
  await page.getByRole("button", { name: "+ Add credential" }).click();
  await page.getByPlaceholder("AWS Production").fill("E2E Loose login");
  await page.getByLabel("Space", { exact: true }).selectOption({ label: "No space (All only)" });
  await page.getByRole("button", { name: "Add credential" }).last().click();
  await expect(page.getByRole("tab", { name: "All, 2 logins" })).toBeVisible();
  await expect(showAll).toHaveCount(0);
});

test("credential manager: spaces can be reordered by arrows and by dragging", async ({ page }) => {
  await createVault(page);
  await openTab(page, "Credential-Manager");
  for (const [platform, space] of [
    ["E2E A", "Alpha"],
    ["E2E B", "Beta"],
  ]) {
    await page.getByRole("button", { name: "+ Add credential" }).click();
    await page.getByPlaceholder("AWS Production").fill(platform);
    await page.getByLabel("Space", { exact: true }).selectOption({ label: "New space…" });
    await page.getByLabel("Space", { exact: true }).fill(space);
    await page.getByRole("button", { name: "Add credential" }).last().click();
    await expect(page.getByText(platform)).toBeVisible();
  }
  const order = () =>
    page.getByRole("tab").evaluateAll((tabs) => tabs.map((t) => t.getAttribute("aria-label")?.split(",")[0]));
  expect(await order()).toEqual(["All", "Alpha", "Beta"]);

  await page.getByRole("button", { name: "Manage spaces" }).click();
  await page.getByRole("button", { name: "Move Beta up" }).click();
  await expect.poll(order).toEqual(["All", "Beta", "Alpha"]);
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: /^Alpha,/ }).dragTo(page.getByRole("tab", { name: /^Beta,/ }));
  await expect.poll(order).toEqual(["All", "Alpha", "Beta"]);
});

test("credential manager: logins can be put in your own order", async ({ page }) => {
  await createVault(page);
  await openTab(page, "Credential-Manager");
  for (const name of ["E2E Alpha", "E2E Bravo", "E2E Charlie"]) {
    await page.getByRole("button", { name: "+ Add credential" }).click();
    await page.getByPlaceholder("AWS Production").fill(name);
    await page.getByRole("button", { name: "Add credential" }).last().click();
    await expect(page.getByText(name)).toBeVisible();
  }
  const order = () => page.locator(".platform-name").allTextContents();
  expect(await order()).toEqual(["E2E Alpha", "E2E Bravo", "E2E Charlie"]); // A–Z until reordered

  await page.getByRole("button", { name: "Reorder" }).click();
  await page.getByRole("button", { name: "Move E2E Charlie up" }).click();
  await expect.poll(order).toEqual(["E2E Alpha", "E2E Charlie", "E2E Bravo"]);

  const row = (name: string) => page.getByRole("row").filter({ hasText: name });
  await row("E2E Alpha").dragTo(row("E2E Bravo"));
  await expect.poll(order).toEqual(["E2E Charlie", "E2E Bravo", "E2E Alpha"]);

  await page.getByRole("button", { name: "Sort A–Z" }).click();
  await expect.poll(order).toEqual(["E2E Alpha", "E2E Bravo", "E2E Charlie"]);
});

test("JSON-Studio doesn't keep a recovery copy of credentials", async ({ page }) => {
  await openTab(page, "JSON-Studio");
  await expect(page.locator("main")).toContainText(/local only/, { timeout: 30_000 });
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type('{"aws":"AKIAIOSFODNN7EXAMPLE"}');
  await expect(page.getByText(/not saved: contains an AWS access key/)).toBeVisible({ timeout: 10_000 });
});

async function addAccount(page: Page, issuer: string) {
  await page.getByRole("button", { name: "+ Add" }).click();
  await page.getByRole("button", { name: "Manual entry" }).click();
  await page.getByPlaceholder("GitHub").fill(issuer);
  await page.getByPlaceholder("user@example.com").fill("e2e@example.com");
  await page.getByPlaceholder("JBSW Y3DP EHPK 3PXP").fill("JBSWY3DPEHPK3PXP");
  await page.getByRole("button", { name: "Add account" }).last().click();
  await expect(page.getByText(issuer)).toBeVisible();
}

test("vault: a deleted account can be undone", async ({ page }) => {
  await createVault(page);
  await addAccount(page, "Undo Me");
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByText("Undo Me")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undo Me")).toBeVisible();
});

test("vault: exporting asks to confirm it's you", async ({ page }) => {
  await createVault(page);
  await addAccount(page, "Export Me");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByText("Enter your master password to export your accounts.")).toBeVisible();
  await page.getByPlaceholder("Master password").fill(PASSWORD);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("dialog", { name: "Export backup" })).toBeVisible({ timeout: 20_000 });
});

test("vault: a change in another tab locks this one instead of being overwritten", async ({ page, context }) => {
  await createVault(page);
  await addAccount(page, "First Tab");

  const other = await context.newPage();
  await other.goto("./");
  await openTab(other, "Authenticator");
  await other.getByPlaceholder("Encryption password").fill(PASSWORD);
  await other.getByRole("button", { name: "Unlock" }).click();
  await expect(other.getByText("First Tab")).toBeVisible({ timeout: 20_000 });
  await addAccount(other, "Second Tab");

  // The first tab held a now-stale copy: it locks and reloads rather than writing over it.
  await expect(page.getByText("The vault was changed in another window")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("Encryption password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Second Tab")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("First Tab")).toBeVisible();
});
