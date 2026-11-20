// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Dialog } from "../../src/shared/ui/Dialog";
import { SearchableSelect } from "../../src/shared/ui/SearchableSelect";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("leaves Escape to the IME without closing the dialog or losing a draft", () => {
  const close = vi.fn();
  render(<Dialog onClose={close}><input aria-label="Name" defaultValue="Unsaved Hook" /></Dialog>);
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(close).not.toHaveBeenCalled();
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
  expect(close).not.toHaveBeenCalled();
  expect((input as HTMLInputElement).value).toBe("Unsaved Hook");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("swallows only the companion Enter across nested dialog and picker guards", () => {
  const change = vi.fn();
  render(<Dialog onClose={vi.fn()}><SearchableSelect aria-label="Branch" defaultValue="" onChange={change}>
    <option value="">Choose</option><option value="main">main</option>
  </SearchableSelect></Dialog>);
  fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));
  const input = screen.getByRole("combobox", { name: "Search options…" });
  fireEvent.change(input, { target: { value: "main" } });
  fireEvent.compositionStart(input);
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: false });
  expect(change).not.toHaveBeenCalled();
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(change).toHaveBeenCalledOnce();
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("expires a composition window and allows normal Enter without an extra keystroke", () => {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const change = vi.fn();
  render(<SearchableSelect aria-label="Branch" onChange={change}><option>main</option></SearchableSelect>);
  fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));
  const input = screen.getByRole("combobox", { name: "Search options…" });
  fireEvent.compositionEnd(input);
  now = 1501;
  fireEvent.keyDown(input, { key: "Enter" });
  expect(change).toHaveBeenCalledOnce();
});
