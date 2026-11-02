// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MenuButton } from "../../src/shared/ui/MenuButton";
import { ContextMenu } from "../../src/shared/ui/ContextMenu";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("lets keyboard users inspect unavailable reasons without executing an action", () => {
  const run = vi.fn();
  render(<MenuButton label="File actions" menuLabel="File actions" explainUnavailable items={[{ id: "none", label: "Apply changes", disabled: true, title: "No changes are available", onSelect: run }]}>File actions</MenuButton>);
  fireEvent.click(screen.getByRole("button", { name: "File actions" }));
  const item = screen.getByRole("menuitem");
  expect(document.activeElement).toBe(item);
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(item.getAttribute("aria-describedby")!)?.textContent).toBe("No changes are available");
  fireEvent.click(item);
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByRole("menu")).toBeTruthy();
});

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

it("ignores a queued trigger scroll but closes when its container actually scrolls again", () => {
  const container = document.createElement("div");
  const trigger = document.createElement("button");
  container.append(trigger);
  document.body.append(container);
  container.scrollTop = 40;
  const onClose = vi.fn();
  render(<ContextMenu x={20} y={20} label="Branch actions" items={[{ id: "copy", label: "Copy", onSelect: vi.fn() }]} returnFocusTo={trigger} onClose={onClose} />);
  fireEvent.scroll(container);
  expect(onClose).not.toHaveBeenCalled();
  container.scrollTop = 80;
  fireEvent.scroll(container);
  expect(onClose).toHaveBeenCalledOnce();
  container.remove();
});

it("closes with Tab and moves past the trigger in either direction", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
  render(<><button>Before</button><MenuButton label="Actions" menuLabel="Actions" items={[{ id: "a", label: "Review", onSelect: vi.fn() }]}>More</MenuButton><button>After</button></>);
  const trigger = screen.getByRole("button", { name: "Actions" });
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Tab" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" })));
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Tab", shiftKey: true });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Before" })));
});
