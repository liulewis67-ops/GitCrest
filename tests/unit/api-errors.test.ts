import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { components } from "../../src/api/schema";
import { GitCrestApiError } from "../../src/api/client";
import { setLocale, translate } from "../../src/shared/i18n";
import { describeApiError, errorText } from "../../src/shared/i18n/api-errors";
import { apiErrorMessages } from "../../src/shared/i18n/messages/api-errors";

// This compile-time check stays in tests to preserve shared -> API import boundaries.
const coverage: Record<`apiError.${components["schemas"]["ApiErrorCode"]}`, readonly [string, string]> = apiErrorMessages;
afterEach(() => setLocale("en"));

it("covers every schema error code in both languages without a second hand-maintained code list", () => {
  const schema = readFileSync(new URL("../../src/api/schema.ts", import.meta.url), "utf8");
  const union = schema.match(/ApiErrorCode: ([^;]+);/)?.[1];
  expect(union).toBeTruthy();
  const codes = [...union!.matchAll(/"([^"]+)"/g)].map((match) => `apiError.${match[1]}`);
  expect(Object.keys(coverage).sort()).toEqual(codes.sort());
  for (const [key, messages] of Object.entries(coverage)) {
    expect(messages[0].length, key).toBeGreaterThan(30);
    expect(messages[1], key).toMatch(/\p{Script=Han}/u);
    expect(messages[0], key).not.toBe(messages[1]);
  }
});

it("translates a missing repository while retaining the untouched diagnostic separately", () => {
  setLocale("zh");
  const error = new GitCrestApiError(404, { error: { code: "REPOSITORY_PATH_NOT_FOUND", message: "The selected repository path no longer exists." } });
  const description = describeApiError(error);
  expect(description.message).toBe(translate("zh", "apiError.REPOSITORY_PATH_NOT_FOUND"));
  expect(description.message).not.toContain(error.message);
  expect(description.details).toContain(error.message);
  setLocale("en");
  expect(errorText(description)).toBe(translate("en", "apiError.REPOSITORY_PATH_NOT_FOUND"));
});

it("uses a translated generic message for a future code and keeps network diagnostics out of the summary", () => {
  setLocale("zh");
  const future = describeApiError({ body: { error: { code: "A_FUTURE_ERROR", message: "Raw future engine failure" } } });
  expect(future.message).toBe(translate("zh", "apiError.unknown"));
  expect(future.details).toContain("Raw future engine failure");
  const network = describeApiError(new Error("Failed to fetch"), "无法连接引擎，请重试。");
  expect(network.message).toBe("无法连接引擎，请重试。");
  expect(network.details).toBe("Failed to fetch");
});
