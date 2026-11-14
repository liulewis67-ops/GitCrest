// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OperationRecoveryResponse } from "../../src/api/client";
import { OperationRecoveryList } from "../../src/features/operations/ui/OperationRecoveryList";

afterEach(cleanup);
const op = (patch: Partial<OperationRecoveryResponse>) => ({
  operationId: "op-1", backups: [], state: { phase: "executing", status: "recoveryRequired", waitReason: "outcomeUnknown" }, version: "1", actionsEnabled: true, allowedActions: ["continuePullRebase", "abortPullRebase"], ...patch,
}) as OperationRecoveryResponse;

it("renders only server-allowed actions and submits the chosen kind", () => {
  const onSubmit = vi.fn();
  render(<OperationRecoveryList operations={[op({})]} error="" submitting="" onSubmit={onSubmit} />);
  fireEvent.click(screen.getByRole("button", { name: "Abort rebase" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op-1" }), "abortPullRebase");
  expect(screen.getAllByRole("button")).toHaveLength(2);
  expect(screen.getByText("State: Recovery required (outcome unknown)")).toBeTruthy();
});
it("shows no buttons for a read-only view and nothing when empty", () => {
  const { container, rerender } = render(<OperationRecoveryList operations={[op({ actionsEnabled: false })]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.getByText(/No action is available/)).toBeTruthy();
  rerender(<OperationRecoveryList operations={[]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(container.firstChild).toBeNull();
});

it("tells the user to resolve conflicts when the operation waits on one and offers no action", () => {
  render(<OperationRecoveryList operations={[op({
    state: { phase: "restoring", status: "waitingForInput", waitReason: "restoreConflict", failureCode: "RESTORE_CONFLICT", resultHeadOid: null },
    allowedActions: [],
  } as never)]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(screen.getByText(/Resolve the conflicts in the working tree/)).toBeTruthy();
  expect(screen.queryByText(/No action is available/)).toBeNull();
});

it("offers the resolve-then-continue action beside the conflict hint", () => {
  const onSubmit = vi.fn();
  render(<OperationRecoveryList operations={[op({
    state: { phase: "restoring", status: "waitingForInput", waitReason: "restoreConflict", failureCode: "RESTORE_CONFLICT", resultHeadOid: null },
    allowedActions: ["reconcileRestoreConflict"],
  } as never)]} error="" submitting="" onSubmit={onSubmit} />);
  expect(screen.getByText(/Resolve the conflicts in the working tree/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "I resolved the conflicts" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.anything(), "reconcileRestoreConflict");
});

it("labels the pull choices individually so they can be told apart", () => {
  render(<OperationRecoveryList operations={[op({
    state: { phase: "preparing", status: "running", waitReason: null, failureCode: null, resultHeadOid: null },
    allowedActions: ["fastForwardPull", "rebasePull", "cancelPreparation"],
  } as never)]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Fast-forward to upstream" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Rebase onto upstream" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
});

it("reads a running operation with offered actions as waiting for the user's choice", () => {
  render(<OperationRecoveryList operations={[op({
    state: { phase: "preparing", status: "running", waitReason: null, failureCode: null, resultHeadOid: null },
    allowedActions: ["reviewFetchedPull", "cancelPreparation"],
  } as never)]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(screen.getByText("State: Waiting for your choice")).toBeTruthy();
  expect(screen.queryByText(/Running/)).toBeNull();
});

it("tells the user how many saved copies of their local changes are still kept", () => {
  render(<OperationRecoveryList operations={[op({
    backups: [
      { shelfId: "a", scope: "index", saveOrder: 0, restoreOrder: 0, baseOid: null, contentDigest: "x", disposition: "restored" },
      { shelfId: "b", scope: "workingTree", saveOrder: 1, restoreOrder: 1, baseOid: null, contentDigest: "y", disposition: "retained" },
    ],
  } as never)]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(screen.getByText("Saved copies of your local changes kept for this operation: 1")).toBeTruthy();
});

it("says nothing about copies when none are retained", () => {
  render(<OperationRecoveryList operations={[op({ backups: [] } as never)]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(screen.queryByText(/Saved copies of your local changes/)).toBeNull();
});

it("explains why an operation stopped in plain words, but leaves conflict waits to their own hint", () => {
  const stopped = op({
    state: { phase: "restoring", status: "recoveryRequired", waitReason: "externalChange", failureCode: "PRECONDITION_CHANGED", resultHeadOid: null },
    allowedActions: [],
  } as never);
  const { rerender } = render(<OperationRecoveryList operations={[stopped]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(screen.getByText("Repository state changed after review. Refresh and review the operation again.")).toBeTruthy();
  rerender(<OperationRecoveryList operations={[op({
    state: { phase: "restoring", status: "waitingForInput", waitReason: "restoreConflict", failureCode: "RESTORE_CONFLICT", resultHeadOid: null },
    allowedActions: [],
  } as never)]} error="" submitting="" onSubmit={vi.fn()} />);
  expect(screen.getByText(/Resolve the conflicts in the working tree/)).toBeTruthy();
  expect(screen.queryByText(/Restoring saved changes caused conflicts/)).toBeNull();
});

it("puts the state, reason and saved-copy count in one labelled live region, apart from the buttons", () => {
  render(<OperationRecoveryList operations={[op({
    state: { phase: "restoring", status: "recoveryRequired", waitReason: "externalChange", failureCode: "PRECONDITION_CHANGED", resultHeadOid: null },
    backups: [{ shelfId: "b", scope: "workingTree", saveOrder: 0, restoreOrder: 0, baseOid: null, contentDigest: "y", disposition: "retained" }],
    allowedActions: ["abortPullRebase"],
  } as never)]} error="" submitting="" onSubmit={vi.fn()} />);
  const region = screen.getByRole("status", { name: "Operation status" });
  expect(region.textContent).toContain("Recovery required");
  expect(region.textContent).toContain("Repository state changed after review");
  expect(region.textContent).toContain("Saved copies of your local changes kept for this operation: 1");
  expect(region.querySelector("button")).toBeNull();
  expect(screen.getByRole("button", { name: "Abort rebase" })).toBeTruthy();
});
