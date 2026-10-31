// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, SubmoduleListResponse } from "../../src/api/client";
import { SubmodulesDialog } from "../../src/features/submodules/ui/SubmodulesDialog";

afterEach(cleanup);

const A = "a".repeat(40);
const B = "b".repeat(40);

function list(items: SubmoduleListResponse["items"]): SubmoduleListResponse {
  return { repoId: "repo_a", items };
}
const upToDate = { name: "libs/inner", path: "libs/inner", url: "https://example.invalid/inner.git", recordedOid: A, committedOid: A, checkedOutOid: A, state: "upToDate" as const };
const outOfDate = { name: "vendor", path: "vendor", url: null, recordedOid: A, committedOid: B, checkedOutOid: B, state: "outOfDate" as const };
const notCloned = { name: "docs", path: "docs", url: "https://example.invalid/docs.git", recordedOid: A, committedOid: A, checkedOutOid: null, state: "uninitialized" as const };

function fakeApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}
function renderDialog(api: GitCrestApiClient, handlers: { disabled?: boolean; onOpen?: (path: string) => void; onStarted?: (task: unknown) => void } = {}) {
  render(<SubmodulesDialog api={api} repoId="repo_a" disabled={handlers.disabled ?? false} onClose={vi.fn()} onOpen={handlers.onOpen ?? vi.fn()} onStarted={handlers.onStarted ?? vi.fn()} />);
}
const row = (path: string) => screen.getByText(path).closest("li") as HTMLElement;

describe("submodules dialog", () => {
  it("shows the recorded and checked-out commit of each submodule and what differs", async () => {
    renderDialog(fakeApi({ listSubmodules: vi.fn().mockResolvedValue(list([upToDate, outOfDate, notCloned])) }));
    expect(await screen.findByText("vendor")).toBeTruthy();
    expect(within(row("libs/inner")).getByText("up to date")).toBeTruthy();
    expect(within(row("vendor")).getByText("differs from the recorded commit")).toBeTruthy();
    // The commit the last commit holds is only shown when it is not the recorded one.
    expect(within(row("vendor")).getByText("In the last commit")).toBeTruthy();
    expect(within(row("libs/inner")).queryByText("In the last commit")).toBeNull();
    expect(within(row("docs")).getByText("not cloned")).toBeTruthy();
    expect(within(row("docs")).getByText("none")).toBeTruthy();
  });

  it("opens an initialized submodule and explains why a missing one cannot be opened", async () => {
    const onOpen = vi.fn();
    renderDialog(fakeApi({ listSubmodules: vi.fn().mockResolvedValue(list([upToDate, notCloned])) }), { onOpen });
    await screen.findByText("docs");
    fireEvent.click(within(row("libs/inner")).getByRole("button", { name: "Open as repository" }));
    expect(onOpen).toHaveBeenCalledWith("libs/inner");
    const missing = within(row("docs")).getByRole("button", { name: "Open as repository" }) as HTMLButtonElement;
    expect(missing.disabled).toBe(true);
    expect(missing.title).toBe("Clone it first with Initialize and update.");
  });

  it("starts an update for one path, initializing only where it was never cloned", async () => {
    const task = { taskId: "task_1" };
    const updateSubmodules = vi.fn().mockResolvedValue(task);
    const onStarted = vi.fn();
    renderDialog(fakeApi({ listSubmodules: vi.fn().mockResolvedValue(list([outOfDate, notCloned])), updateSubmodules }), { onStarted });
    await screen.findByText("vendor");
    fireEvent.click(within(row("vendor")).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(task));
    expect(updateSubmodules).toHaveBeenLastCalledWith("repo_a", { paths: ["vendor"], init: false });
    fireEvent.click(within(row("docs")).getByRole("button", { name: "Initialize and update" }));
    await waitFor(() => expect(updateSubmodules).toHaveBeenLastCalledWith("repo_a", { paths: ["docs"], init: true }));
  });

  it("keeps updates off, with the reason, while a task runs or nothing differs", async () => {
    renderDialog(fakeApi({ listSubmodules: vi.fn().mockResolvedValue(list([upToDate])) }), { disabled: true });
    await screen.findByText("libs/inner");
    const update = within(row("libs/inner")).getByRole("button", { name: "Update" }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    expect(update.title).toBe("Wait for the running Git task to finish.");
    cleanup();
    renderDialog(fakeApi({ listSubmodules: vi.fn().mockResolvedValue(list([upToDate])) }));
    await screen.findByText("libs/inner");
    const idle = within(row("libs/inner")).getByRole("button", { name: "Update" }) as HTMLButtonElement;
    expect(idle.disabled).toBe(true);
    expect(idle.title).toBe("Already at the recorded commit.");
    expect((screen.getByRole("button", { name: "Update all" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when there are no submodules and reports a failed read", async () => {
    renderDialog(fakeApi({ listSubmodules: vi.fn().mockResolvedValue(list([])) }));
    expect(await screen.findByText("This repository has no submodules.")).toBeTruthy();
    cleanup();
    renderDialog(fakeApi({ listSubmodules: vi.fn().mockRejectedValue(new Error("Git could not read the submodules.")) }));
    expect((await screen.findByRole("alert")).textContent).toContain("Git could not read the submodules.");
  });
});
