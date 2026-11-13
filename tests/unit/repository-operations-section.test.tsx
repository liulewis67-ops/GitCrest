// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { RepositoryOperationsSection } from "../../src/features/operations/ui/RepositoryOperationsSection";

afterEach(cleanup);

it("loads operations on mount and reuses the request id when the same action is retried", async () => {
  const operation = { operationId: "op-1", state: { phase: "executing", status: "recoveryRequired", waitReason: "outcomeUnknown" }, version: "3", actionsEnabled: true, allowedActions: ["abortPullRebase"] };
  const submit = vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValue({ action: {}, task: null });
  let api: Record<string, unknown>;
  api = { withSignal: () => api, listActiveRepositoryOperations: vi.fn().mockResolvedValue([operation]), submitRepositoryOperationAction: submit };
  render(<RepositoryOperationsSection api={api as unknown as GitCrestApiClient} repoId="repo-1" />);
  const button = await screen.findByRole("button", { name: "Abort" });
  fireEvent.click(button);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((screen.getByRole("button", { name: "Abort" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Abort" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1][2].requestId).toBe(submit.mock.calls[0][2].requestId);
});

it("re-reads the active operations when the refresh token changes", async () => {
  const list = vi.fn().mockResolvedValue([]);
  let api: Record<string, unknown>;
  api = { withSignal: () => api, listActiveRepositoryOperations: list };
  const client = api as unknown as GitCrestApiClient;
  const { rerender } = render(<RepositoryOperationsSection api={client} repoId="repo-1" refreshToken="" />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  rerender(<RepositoryOperationsSection api={client} repoId="repo-1" refreshToken="t1:running" />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  rerender(<RepositoryOperationsSection api={client} repoId="repo-1" refreshToken="t1:running" />);
  expect(list).toHaveBeenCalledTimes(2);
});
