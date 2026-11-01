// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MenuButton } from "../../src/shared/ui/MenuButton";
import { ContextMenu } from "../../src/shared/ui/ContextMenu";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("flips a bottom-edge menu above its trigger and navigates enabled choices", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("actionMenu") ? new DOMRect(0, 0, 240, 200) : new DOMRect(900, 740, 40, 20);
  });
  render(<MenuButton label="Actions" menuLabel="Actions" items={[{ id: "a", label: "Review", onSelect: vi.fn() }, { id: "b", label: "Unavailable", disabled: true, onSelect: vi.fn() }, { id: "c", label: "Delete", danger: true, separatorBefore: true, onSelect: vi.fn() }]}>More</MenuButton>);
  const opener = screen.getByRole("button", { name: "Actions" });
  fireEvent.click(opener);
  const menu = screen.getByRole("menu");
  expect(menu.style.top).toBe("536px");
  expect(menu.style.left).toBe("700px");
  const first = screen.getByRole("menuitem", { name: "Review" });
  const last = screen.getByRole("menuitem", { name: "Delete" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Home" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "End" });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("keeps a long context menu open while scrolling its contents and dismisses on background scroll", () => {
  const onClose = vi.fn();
  render(<ContextMenu x={20} y={20} label="Actions" items={[{ id: "a", label: "Review", onSelect: vi.fn() }]} onClose={onClose} />);
  fireEvent.scroll(screen.getByRole("menu"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.scroll(document.body);
  expect(onClose).toHaveBeenCalledOnce();
});
