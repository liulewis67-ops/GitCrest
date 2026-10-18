// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../../src/shared/i18n/en";
import { zh } from "../../src/shared/i18n/zh";
import { LOCALE_STORAGE_KEY, getLocale, setLocale, translate } from "../../src/shared/i18n";

describe("i18n", () => {
  afterEach(() => setLocale("en"));

  it("keeps the English and Chinese catalogs on the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("interpolates params and leaves unknown placeholders intact", () => {
    expect(translate("en", "titlebar.closeTabLabel", { name: "repo" })).toBe("Close repo tab");
    expect(translate("zh", "titlebar.closeTabLabel", { name: "repo" })).toBe("关闭 repo 标签页");
    expect(translate("en", "titlebar.closeTabLabel")).toBe("Close {name} tab");
  });

  it("persists the selected locale", () => {
    setLocale("zh");
    expect(getLocale()).toBe("zh");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
