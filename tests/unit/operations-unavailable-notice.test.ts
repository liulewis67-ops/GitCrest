// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { announceOperationsUnavailable, resetOperationsUnavailableNotice } from "../../src/features/operations";
import { clearNotices, useNotices } from "../../src/shared/notices/notice-store";
import { renderHook } from "@testing-library/react";
import { setLocale } from "../../src/shared/i18n";

beforeEach(() => { clearNotices(); resetOperationsUnavailableNotice(); setLocale("en"); });
afterEach(() => { clearNotices(); resetOperationsUnavailableNotice(); setLocale("en"); });

it("warns once per session that protected operations could not be used", () => {
  announceOperationsUnavailable();
  announceOperationsUnavailable();
  const { result } = renderHook(() => useNotices());
  expect(result.current).toHaveLength(1);
  expect(result.current[0].kind).toBe("warning");
});

it("speaks Chinese when the language is Chinese", () => {
  setLocale("zh");
  announceOperationsUnavailable();
  const { result } = renderHook(() => useNotices());
  expect(String(result.current[0].message)).toMatch(/[一-鿿]/);
});
