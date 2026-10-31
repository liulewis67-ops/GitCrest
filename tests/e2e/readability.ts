import type { Page } from "playwright";
import { expect } from "vitest";

/** Check rendered text, including control values and placeholders, in a live window. */
export async function expectReadableText(page: Page, windowName: string) {
  const undersized = await page.evaluate(() => {
    const elements = [...document.querySelectorAll<HTMLElement>("body *")];
    return elements.flatMap((element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility !== "visible" || element.getClientRects().length === 0) return [];
      const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim());
      const controlText = element instanceof HTMLInputElement
        ? element.value || element.placeholder
        : element instanceof HTMLTextAreaElement ? element.value || element.placeholder : "";
      if (!ownText && !controlText) return [];
      const size = parseFloat(style.fontSize);
      return size < 11 ? [{ tag: element.tagName, className: element.className, text: (element.textContent || controlText).trim().slice(0, 60), size }] : [];
    });
  });
  expect(undersized, `${windowName} has text below the 11px Phase 1 floor`).toEqual([]);
}
