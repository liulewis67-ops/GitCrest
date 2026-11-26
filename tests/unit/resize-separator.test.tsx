// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizeSeparator } from "../../src/shared/ui/ResizeSeparator";
import { useWorkspaceLayout } from "../../src/features/repositories/model/use-workspace-layout";

beforeEach(() => {
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("saves the last layout when switching repositories before the debounce expires", () => {
  const key = "gitcrest-layout-resize-test-sidebar-width";
  window.localStorage.removeItem(key);
  const { result, rerender, unmount } = renderHook<ReturnType<typeof useWorkspaceLayout>, { repoId?: string }>(({ repoId }) => useWorkspaceLayout(repoId),
    { initialProps: { repoId: "resize-test" } });
  act(() => result.current.setSidebarWidth(325));
  act(() => result.current.setSidebarWidth(350));
  expect(window.localStorage.getItem(key)).toBeNull();
  rerender({ repoId: undefined });
  expect(window.localStorage.getItem(key)).toBe("350");
  unmount();
  window.localStorage.removeItem(key);
});

describe("ResizeSeparator", () => {
  it("restores the starting width and releases dragging on Escape even after focus moves", () => {
    const onResize = vi.fn();
    render(<ResizeSeparator orientation="vertical" edge="left" value={280} min={160} max={560} label="Resize" onResize={onResize} />);
    const rule = screen.getByRole("separator");
    fireEvent.pointerDown(rule, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(rule, { pointerId: 1, clientX: 170 });
    act(() => vi.advanceTimersToNextFrame());
    expect(onResize).toHaveBeenLastCalledWith(350);
    fireEvent.pointerMove(rule, { pointerId: 1, clientX: 190 });
    fireEvent.keyDown(document.body, { key: "Escape" });
    act(() => vi.advanceTimersToNextFrame());
    expect(onResize).toHaveBeenLastCalledWith(280);
    expect(rule.classList.contains("dragging")).toBe(false);
    expect(document.documentElement.classList.contains("resizingColumns")).toBe(false);
    fireEvent.pointerMove(rule, { pointerId: 1, clientX: 200 });
    expect(onResize).toHaveBeenCalledTimes(2);
  });
  it("marks a drag on the rule and keeps the resize cursor window-wide until the pointer is released", () => {
    const onResize = vi.fn();
    render(<ResizeSeparator orientation="vertical" edge="left" value={240} min={160} max={560} label="Resize changed files" onResize={onResize} />);
    const rule = screen.getByRole("separator", { name: "Resize changed files" });
    expect(rule.dataset.edge).toBe("left");
    expect(rule.className).toBe("resizeSeparator vertical");

    fireEvent.pointerDown(rule, { pointerId: 1, button: 0, clientX: 100 });
    expect(rule.className).toBe("resizeSeparator vertical dragging");
    expect(document.documentElement.classList.contains("resizingColumns")).toBe(true);
    fireEvent.pointerMove(rule, { pointerId: 1, clientX: 140 });
    act(() => vi.advanceTimersToNextFrame());
    expect(onResize).toHaveBeenLastCalledWith(280);

    fireEvent.pointerUp(rule, { pointerId: 1 });
    expect(rule.className).toBe("resizeSeparator vertical");
    expect(document.documentElement.classList.contains("resizingColumns")).toBe(false);
    fireEvent.pointerMove(rule, { pointerId: 1, clientX: 200 });
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it("applies only the latest pointer movement per frame and flushes it on release", () => {
    const onResize = vi.fn();
    render(<ResizeSeparator orientation="vertical" edge="left" value={240} min={160} max={560} label="Resize" onResize={onResize} />);
    const rule = screen.getByRole("separator");
    fireEvent.pointerDown(rule, { pointerId: 1, button: 0, clientX: 100 });
    for (const clientX of [105, 110, 120]) fireEvent.pointerMove(rule, { pointerId: 1, clientX });
    expect(onResize).not.toHaveBeenCalled();
    act(() => vi.advanceTimersToNextFrame());
    expect(onResize).toHaveBeenCalledExactlyOnceWith(260);
    fireEvent.pointerMove(rule, { pointerId: 1, clientX: 130 });
    fireEvent.pointerUp(rule, { pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(270);
    act(() => vi.advanceTimersToNextFrame());
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it("ignores secondary buttons and ends a drag whose pointer capture is lost", () => {
    render(<ResizeSeparator orientation="horizontal" edge="top" value={320} min={120} max={900} label="Resize commit graph" onResize={vi.fn()} />);
    const rule = screen.getByRole("separator", { name: "Resize commit graph" });
    fireEvent.pointerDown(rule, { pointerId: 1, button: 2, clientY: 100 });
    expect(rule.classList.contains("dragging")).toBe(false);

    fireEvent.pointerDown(rule, { pointerId: 2, button: 0, clientY: 100 });
    expect(document.documentElement.classList.contains("resizingRows")).toBe(true);
    fireEvent.lostPointerCapture(rule, { pointerId: 2 });
    expect(rule.classList.contains("dragging")).toBe(false);
    expect(document.documentElement.classList.contains("resizingRows")).toBe(false);
  });
});
