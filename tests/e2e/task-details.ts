import type { Page } from "playwright";

/** Task history is opened explicitly by the user, never by starting an operation. */
export async function openTaskDetails(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Tasks", exact: true });
  if (!await dialog.isVisible()) await page.locator(".taskCenterButton").click();
  await dialog.waitFor();
  return dialog;
}
