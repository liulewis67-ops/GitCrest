// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
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
