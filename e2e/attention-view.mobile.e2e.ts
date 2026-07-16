import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => gotoFresh(page));

const qna = (page: import("@playwright/test").Page) =>
  page.getByRole("group", { name: "Questions" });
const shelf = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /open (question pending|approval required)/i });

test("an incoming question auto-presents as a full-screen phone view", async ({
  page,
}) => {
  await drive(page, "qna");
  await expect(qna(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Minimize questions" })).toBeVisible();
  const box = await page.locator(".qna-inline-wrap.phone-full").boundingBox();
  expect(box?.width).toBe(page.viewportSize()?.width);
  expect(box?.height).toBeGreaterThan(700);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThanOrEqual(
    (page.viewportSize()?.height ?? 0) - 2,
  );
});

test("an incoming approval fills the phone chat viewport", async ({ page }) => {
  await drive(page, "confirm");
  const box = await page.getByRole("dialog", { name: "Run destructive command?" }).boundingBox();
  expect(box?.width).toBe(page.viewportSize()?.width);
  expect(box?.height).toBeGreaterThan(700);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThanOrEqual(
    (page.viewportSize()?.height ?? 0) - 2,
  );
});

test("minimize shows a persistent shelf above the composer and restores", async ({
  page,
}) => {
  await drive(page, "qna");
  await page.getByRole("button", { name: "Minimize questions" }).click();
  await expect(qna(page)).toBeHidden();
  await expect(shelf(page)).toContainText("A few questions before I proceed");
  await expect.poll(() => page.evaluate(() => history.state?.pantokenOverlay ?? null)).toBeNull();
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();
  await shelf(page).click();
  await expect(qna(page)).toBeVisible();
  await expect(shelf(page)).toBeHidden();
});

test("browser Back minimizes the attention view", async ({ page }) => {
  await drive(page, "confirm");
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeHidden();
  await expect(shelf(page)).toBeVisible();
});

test("incoming attention replaces an open phone navigation view cleanly", async ({ page }) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "true");
  await page.evaluate(() =>
    (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock?.(
      "confirm",
    ),
  );
  await expect(sidebar).toHaveAttribute("data-open", "false");
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeVisible();
  await page.goBack();
  await expect(shelf(page)).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-open", "false");
});

test("opening phone navigation minimizes attention without stranding history", async ({
  page,
}) => {
  await drive(page, "confirm");
  // Wait for the approval to land before opening the sidebar: the mock streams
  // asynchronously, and if the sidebar opens first, the late-arriving approval
  // fires the attention effect which resets mobileView to "transcript" and
  // closes the sidebar.
  await expect(
    page.getByRole("dialog", { name: "Run destructive command?" }),
  ).toBeVisible();
  await page
    .getByTestId("sidebar-open")
    .evaluate((button) => (button as HTMLButtonElement).click());
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "true");
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeHidden();
  await page.goBack();
  await expect(sidebar).toHaveAttribute("data-open", "false");
  await expect(shelf(page)).toBeVisible();
  await shelf(page).click();
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeVisible();
  await page.goBack();
  await expect(shelf(page)).toBeVisible();
});

test("a deliberate minimize stays sticky when another request arrives", async ({
  page,
}) => {
  await drive(page, "qna");
  await page.getByRole("button", { name: "Minimize questions" }).click();
  await drive(page, "confirm");
  await expect(shelf(page)).toContainText("2 items need attention");
  await expect(qna(page)).toBeHidden();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("switching sessions clears the active session's minimized presentation state", async ({
  page,
}) => {
  await drive(page, "qna");
  await page.getByRole("button", { name: "Minimize questions" }).click();
  await drive(page, "bgwait");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("Explore the fold reducer").click();
  await page.getByRole("button", { name: "Minimize approval" }).click();
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("Wire up the WebSocket bridge").click();
  await expect(qna(page)).toBeVisible();
});

test("multiple requests navigate and resolution advances to the oldest remaining", async ({
  page,
}) => {
  await drive(page, "qna");
  await page.getByRole("button", { name: "Minimize questions" }).click();
  await drive(page, "confirm");
  await shelf(page).click();
  await expect(qna(page)).toBeVisible();
  await page.getByRole("button", { name: "Previous pending request" }).click();
  await expect(page.getByText("2 of 2")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeVisible();
  await page.getByRole("button", { name: "Next pending request" }).click();
  await expect(qna(page)).toBeVisible();
  await page.getByRole("button", { name: "Next pending request" }).click();
  const approval = page.getByRole("dialog", { name: "Run destructive command?" });
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(qna(page)).toBeVisible();
  await expect(page.getByText("1 of 2")).toBeHidden();
});

test("approval input drafts survive minimize and pending-request navigation", async ({
  page,
}) => {
  await drive(page, "input");
  const input = page.getByRole("dialog", { name: "Commit message" }).getByRole("textbox");
  await input.fill("Keep this draft");
  await page.getByRole("button", { name: "Minimize approval" }).click();
  await drive(page, "confirm");
  await shelf(page).click();
  await expect(input).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Next pending request" }).click();
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeVisible();
  await page.getByRole("button", { name: "Previous pending request" }).click();
  await expect(input).toHaveValue("Keep this draft");
});

test("approval input drafts survive reload and clear after resolution", async ({ page }) => {
  await drive(page, "input");
  const dialog = page.getByRole("dialog", { name: "Commit message" });
  const input = dialog.getByRole("textbox");
  await input.fill("Persist this approval draft");
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Commit message" }).getByRole("textbox"))
    .toHaveValue("Persist this approval draft");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("pantoken.approvalDrafts") ?? "[]"),
    )
    .toBe("[]");
});

test("a timed approval resolves while another request remains selected", async ({ page }) => {
  await drive(page, "timeout");
  await page.getByRole("button", { name: "Minimize approval" }).click();
  await drive(page, "qna");
  await shelf(page).click();
  await page.getByRole("button", { name: "Next pending request" }).click();
  await expect(qna(page)).toBeVisible();
  await expect(page.getByText("2 of 2")).toBeHidden({ timeout: 4000 });
  await expect(qna(page)).toBeVisible();
});

test("resolving the final request removes the overlay and shelf", async ({ page }) => {
  await drive(page, "confirm");
  const approval = page.getByRole("dialog", { name: "Run destructive command?" });
  await approval.getByRole("button", { name: "Allow" }).click();
  await expect(approval).toBeHidden();
  await expect(shelf(page)).toBeHidden();
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();
});
