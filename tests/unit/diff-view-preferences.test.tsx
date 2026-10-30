// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDiffViewPreferences } from "../../src/features/diff/model/use-diff-view-preferences";

beforeEach(() => localStorage.clear());

describe("diff view preferences", () => {
  it("toggles from the current value even through an updater captured earlier", () => {
    const { result } = renderHook(() => useDiffViewPreferences());
    // A keyboard handler registered once keeps using the updater from the first render.
    const staleUpdate = result.current.updatePreferences;
    expect(result.current.preferences.sideBySide).toBe(true);

    act(() => staleUpdate((current) => ({ sideBySide: !current.sideBySide })));
    expect(result.current.preferences.sideBySide).toBe(false);
    act(() => staleUpdate((current) => ({ sideBySide: !current.sideBySide })));
    expect(result.current.preferences.sideBySide).toBe(true);
  });

  it("remembers the layout for the next window", () => {
    const first = renderHook(() => useDiffViewPreferences());
    act(() => first.result.current.updatePreferences({ sideBySide: false }));
    first.unmount();
    const second = renderHook(() => useDiffViewPreferences());
    expect(second.result.current.preferences.sideBySide).toBe(false);
  });
});
