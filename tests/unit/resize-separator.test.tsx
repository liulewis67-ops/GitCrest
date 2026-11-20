// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizeSeparator } from "../../src/shared/ui/ResizeSeparator";

beforeEach(() => {
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
afterEach(cleanup);

describe("ResizeSeparator", () => {
  it("restores the starting width and releases dragging on Escape even after focus moves", () => {
    const onResize = vi.fn();
    render(<ResizeSeparator orientation="vertical" edge="left" value={280} min={160} max={560} label="Resize" onResize={onResize} />);
    const rule = screen.getByRole("separator");
    fireEvent.pointerDown(rule, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(rule, { pointerId: 1, clientX: 170 });
    expect(onResize).toHaveBeenLastCalledWith(350);
    fireEvent.keyDown(document.body, { key: "Escape" });
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
    expect(onResize).toHaveBeenLastCalledWith(280);

    fireEvent.pointerUp(rule, { pointerId: 1 });
    expect(rule.className).toBe("resizeSeparator vertical");
    expect(document.documentElement.classList.contains("resizingColumns")).toBe(false);
    fireEvent.pointerMove(rule, { pointerId: 1, clientX: 200 });
    expect(onResize).toHaveBeenCalledTimes(1);
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
