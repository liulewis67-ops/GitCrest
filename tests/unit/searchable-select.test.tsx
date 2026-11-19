// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { SearchableSelect } from "../../src/shared/ui/SearchableSelect";
import { Dialog } from "../../src/shared/ui/Dialog";
import { PipelineRuleEditor } from "../../src/features/pipelines/ui/PipelineRuleEditor";
import { newPipelineRule } from "../../src/features/pipelines/model/rule-form";

afterEach(cleanup);

function Example({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("origin/main");
  return <label>Target<SearchableSelect value={value} disabled={disabled} onChange={(event) => setValue(event.target.value)}>
    <option value="">Choose a branch</option>
    <option value="origin/main">origin/main</option>
    <option value="origin/feature/中文">origin/feature/中文</option>
    <option value="origin/disabled" disabled>origin/disabled</option>
  </SearchableSelect></label>;
}

it("filters a branch list and updates the original controlled select", () => {
  render(<Example />);
  const select = screen.getByLabelText("Target");
  fireEvent.click(select);
  const search = screen.getByRole("combobox", { name: "Search options…" });
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: "FEATURE/中文" } });
  const list = screen.getByRole("listbox");
  expect(within(list).getAllByRole("option")).toHaveLength(1);
  fireEvent.click(within(list).getByRole("option"));
  expect(select).toHaveValue("origin/feature/中文");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(select);
});

it("supports empty results, disabled options and keyboard selection", () => {
  render(<Example />);
  const select = screen.getByLabelText("Target");
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const search = screen.getByRole("combobox", { name: "Search options…" });
  fireEvent.change(search, { target: { value: "missing" } });
  expect(screen.getByRole("status")).toHaveTextContent("No matching options");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(select).toHaveValue("origin/main");
  fireEvent.change(search, { target: { value: "disabled" } });
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option"));
  expect(select).toHaveValue("origin/main");
  fireEvent.change(search, { target: { value: "中文" } });
  fireEvent.keyDown(search, { key: "Enter", isComposing: true });
  expect(select).toHaveValue("origin/main");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(select).toHaveValue("origin/feature/中文");
});

it("keeps the popup in the modal and Escape only closes the dropdown", () => {
  const close = vi.fn();
  render(<Dialog onClose={close}><Example /></Dialog>);
  fireEvent.click(screen.getByLabelText("Target"));
  expect(screen.getByRole("dialog")).toContainElement(screen.getByRole("listbox"));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search options…" }), { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("closes on outside interaction and resets the query when reopened", () => {
  render(<><Example /><button>Outside</button></>);
  const select = screen.getByLabelText("Target");
  fireEvent.click(select);
  fireEvent.change(screen.getByRole("combobox", { name: "Search options…" }), { target: { value: "missing" } });
  fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(select);
  expect(screen.getByRole("combobox", { name: "Search options…" })).toHaveValue("");
});

it("closes an open popup if the control becomes disabled", () => {
  const { rerender } = render(<Example />);
  fireEvent.click(screen.getByLabelText("Target"));
  rerender(<Example disabled />);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByLabelText("Target")).toBeDisabled();
});

it("searches and adds a target from a long Hook branch list", () => {
  render(<PipelineRuleEditor rule={newPipelineRule("r_01")} otherRules={[]} localBranches={[]}
    remoteBranches={Array.from({ length: 300 }, (_, index) => ({ remote: "origin", branch: `feature/task-${index}` }))}
    onSave={vi.fn()} onCancel={vi.fn()} />);
  const select = screen.getByRole("combobox", { name: "Choose a remote branch" });
  fireEvent.click(select);
  fireEvent.change(screen.getByRole("combobox", { name: "Search options…" }), { target: { value: "TASK-299" } });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search options…" }), { key: "Enter" });
  expect(select).toHaveValue("origin/feature/task-299");
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  expect(screen.getByText("origin/feature/task-299")).toBeTruthy();
});
