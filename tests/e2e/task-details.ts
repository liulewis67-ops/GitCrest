import type { Page } from "playwright";

/** Task history is opened explicitly by the user, never by starting an operation. */
export async function openTaskDetails(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Tasks", exact: true });
  // The dialog is loaded lazily after the click that opens it, so give it a moment before clicking again,
  // which would otherwise land on its backdrop.
  const alreadyOpening = await dialog.waitFor({ state: "visible", timeout: 1_500 }).then(() => true, () => false);
  if (!alreadyOpening) await page.locator(".taskCenterButton").click();
  await dialog.waitFor();
  return dialog;
}
