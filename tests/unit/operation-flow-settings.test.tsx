// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OperationFlowSettings } from "../../src/features/operations";
import { OPERATION_FLOW_KEY, isOperationFlowEnabled } from "../../src/shared/preferences/operation-flow";

afterEach(() => { cleanup(); localStorage.removeItem(OPERATION_FLOW_KEY); });

it("is off by default and turns the opt-in on and off", () => {
  render(<OperationFlowSettings />);
  const toggle = screen.getByRole("checkbox", { name: "Use protected operations" }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(isOperationFlowEnabled()).toBe(false);

  fireEvent.click(toggle);
  expect((screen.getByRole("checkbox", { name: "Use protected operations" }) as HTMLInputElement).checked).toBe(true);
  expect(localStorage.getItem(OPERATION_FLOW_KEY)).toBe("on");
  expect(isOperationFlowEnabled()).toBe(true);

  fireEvent.click(screen.getByRole("checkbox", { name: "Use protected operations" }));
  expect(localStorage.getItem(OPERATION_FLOW_KEY)).toBeNull();
  expect(isOperationFlowEnabled()).toBe(false);
});

it("reflects a change made elsewhere, such as another window", () => {
  render(<OperationFlowSettings />);
  act(() => {
    localStorage.setItem(OPERATION_FLOW_KEY, "on");
    window.dispatchEvent(new Event("storage"));
  });
  expect((screen.getByRole("checkbox", { name: "Use protected operations" }) as HTMLInputElement).checked).toBe(true);
});

it("says so when the setting cannot be saved, and stays off", () => {
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => { throw new Error("storage unavailable"); };
  try {
    render(<OperationFlowSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Use protected operations" }));
    expect(screen.getByRole("alert").textContent).toBe("Could not save this setting.");
    expect(isOperationFlowEnabled()).toBe(false);
  } finally {
    Storage.prototype.setItem = original;
  }
});
