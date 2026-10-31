// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setLocale, translate } from "../../src/shared/i18n";
import { describeApiError } from "../../src/shared/i18n/api-errors";
import { ErrorMessage } from "../../src/shared/ui/ErrorMessage";

afterEach(() => { cleanup(); setLocale("en"); });

it("shows Chinese recovery guidance and reveals core text only when Details is expanded", () => {
  setLocale("zh");
  render(<ErrorMessage error={describeApiError({ body: { error: { code: "HISTORY_UNAVAILABLE", message: "Raw English engine diagnostic" } } })} />);
  expect(screen.getByText(translate("zh", "apiError.HISTORY_UNAVAILABLE"))).toBeTruthy();
  const disclosure = screen.getByRole("button", { name: "详情" });
  const diagnostic = document.getElementById(disclosure.getAttribute("aria-controls")!);
  expect(diagnostic?.textContent).toContain("Raw English engine diagnostic");
  expect(diagnostic?.hidden).toBe(true);
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(diagnostic?.hidden).toBe(false);
  fireEvent.click(disclosure);
  expect(diagnostic?.hidden).toBe(true);
});
