// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BranchSyncBadge } from "../../src/features/branches/ui/BranchSyncBadge";

afterEach(cleanup);

const base = { kind: "local" as const, upstream: "origin/main", upstreamGone: false, ahead: 0, behind: 0 };

it("shows ahead and behind counts only when the branch diverges from its upstream", () => {
  const view = render(<BranchSyncBadge branch={{ ...base, ahead: 2, behind: 1 }} />);
  expect(screen.getByLabelText("2 ahead, 1 behind of origin/main").textContent).toBe("↑2↓1");
  view.rerender(<BranchSyncBadge branch={base} />);
  expect(view.container.textContent).toBe("");
  view.rerender(<BranchSyncBadge branch={{ ...base, upstream: null }} />);
  expect(view.container.textContent).toBe("");
  view.rerender(<BranchSyncBadge branch={{ ...base, kind: "remote", ahead: 3 }} />);
  expect(view.container.textContent).toBe("");
});

it("flags a deleted upstream", () => {
  render(<BranchSyncBadge branch={{ ...base, upstreamGone: true }} />);
  expect(screen.getByText("upstream gone")).toBeTruthy();
});

it("colors the two directions apart and prints direction and count, so color is never the only signal", () => {
  const { container } = render(<BranchSyncBadge branch={{ ...base, ahead: 4, behind: 2 }} />);
  expect(container.querySelector(".branchSyncArrow.ahead")?.textContent).toBe("↑4");
  expect(container.querySelector(".branchSyncArrow.behind")?.textContent).toBe("↓2");
});

it("marks a local branch that has no upstream only when asked to", () => {
  const view = render(<BranchSyncBadge branch={{ ...base, upstream: null }} showUnpublished />);
  expect(screen.getByLabelText("Not published: this branch has no upstream").textContent).toBe("↑");
  view.rerender(<BranchSyncBadge branch={{ ...base, kind: "remote", upstream: null }} showUnpublished />);
  expect(view.container.textContent).toBe("");
});

it("makes each arrow a button when handlers are given, and only the direction that has commits", () => {
  const onPush = vi.fn();
  const onPull = vi.fn();
  render(<BranchSyncBadge branch={{ ...base, ahead: 1, behind: 0 }} onPush={onPush} onPull={onPull} />);
  fireEvent.click(screen.getByRole("button", { name: "Push 1 commits to origin/main" }));
  expect(onPush).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: /Pull/ })).toBeNull();
  expect(onPull).not.toHaveBeenCalled();
});
