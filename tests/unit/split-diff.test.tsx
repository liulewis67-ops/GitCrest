// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffDocumentResponse } from "../../src/api/client";
import { SplitDiff } from "../../src/features/diff/ui/SplitDiff";

vi.mock("../../src/features/diff/ui/MonacoDiffHunk", () => ({
  MonacoDiffHunk: (props: { original: string; modified: string; language: string; treeSitterGrammar: string | null }) => createElement(
    "pre",
    { "data-testid": "monaco-diff-hunk" },
    `${props.language}|${props.original}||${props.modified}`,
  ),
}));

afterEach(cleanup);

describe("SplitDiff", () => {
  it("previews ignored file contents without staging or discarding controls", () => {
    const document: DiffDocumentResponse = {
      repoId: "repo_fixture", path: "ignored.log", revision: "sha256:ignored",
      originalPath: null, scope: "workingTree", changeKind: "ignored", status: "text",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1,
        rows: [{ kind: "change", oldLine: null, newLine: 1, oldText: null, newText: "local content" }] }],
    };
    render(<SplitDiff document={document} onStageSelection={vi.fn()} onDiscardSelection={vi.fn()} disabled={false} />);
    expect(screen.getByText("local content")).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /stage|unstage|discard/i })).toBeNull();
  });

  it("keeps historical commit diffs read-only", () => {
    const onStageSelection = vi.fn();
    const document: DiffDocumentResponse = {
      repoId: "repo_fixture",
      path: "src/file.ts",
      revision: "sha256:commit-fixture",
      originalPath: null,
      scope: "commit",
      changeKind: "modified",
      status: "text",
      hunks: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "old", newText: "new" }],
      }],
    };
    render(<SplitDiff document={document} onStageSelection={onStageSelection} disabled={false} />);

    expect(screen.getByText("COMMIT ↔ FIRST PARENT")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    expect(screen.getByRole("group", { name: "Deleted line 1: old" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Added line 1: new" })).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /stage|unstage/i })).toBeNull();
    expect(onStageSelection).not.toHaveBeenCalled();
  });

  it("shows an explicit binary state instead of trying to render text", () => {
    const document: DiffDocumentResponse = {
      repoId: "repo_fixture",
      path: "assets/image.bin",
      revision: "sha256:binary-fixture",
      originalPath: null,
      scope: "workingTree",
      changeKind: "modified",
      status: "binary",
      hunks: [],
    };
    render(<SplitDiff document={document} onStageSelection={vi.fn()} disabled={false} />);

    expect(screen.getByRole("status").textContent).toContain("file is binary");
    expect(screen.queryByRole("button", { name: "Monaco view" })).toBeNull();
  });

  it("keeps a working tree diff read-only when rendered in a separate window", () => {
    const document: DiffDocumentResponse = {
      repoId: "repo_fixture",
      path: "src/file.ts",
      revision: "sha256:readonly-window-fixture",
      originalPath: null,
      scope: "workingTree",
      changeKind: "modified",
      status: "text",
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "before", newText: "after" }] }],
    };
    render(<SplitDiff document={document} onStageSelection={vi.fn()} disabled={false} readOnly />);

    expect(screen.getByText("before")).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /stage|unstage/i })).toBeNull();
  });

  it("navigates changed hunks with F7 and collapses or expands hunk rows", () => {
    const document: DiffDocumentResponse = {
      repoId: "repo_fixture",
      path: "src/file.ts",
      revision: "sha256:navigation-fixture",
      originalPath: null,
      scope: "commit",
      changeKind: "modified",
      status: "text",
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "before one", newText: "after one" }] },
        { oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, rows: [{ kind: "change", oldLine: 20, newLine: 20, oldText: "before two", newText: "after two" }] },
      ],
    };
    render(<SplitDiff document={document} onStageSelection={vi.fn()} disabled={false} />);

    expect(screen.getByText("0 / 2 changes")).toBeDefined();
    fireEvent.keyDown(window, { key: "F7" });
    expect(screen.getByText("1 / 2 changes")).toBeDefined();
    expect(screen.getByRole("region", { name: "Change hunk 1" }).className).toContain("splitDiffHunk-active");

    fireEvent.click(screen.getByRole("button", { name: "Collapse hunk 1" }));
    expect(screen.getByRole("region", { name: "Change hunk 1" }).textContent).not.toContain("after one");
    fireEvent.keyDown(window, { key: "F7" });
    expect(screen.getByText("2 / 2 changes")).toBeDefined();
    expect(screen.getByRole("region", { name: "Change hunk 2" }).textContent).toContain("after two");
    fireEvent.keyDown(window, { key: "F7", shiftKey: true });
    expect(screen.getByText("1 / 2 changes")).toBeDefined();
    expect(screen.getByRole("region", { name: "Change hunk 1" }).textContent).toContain("after one");
    fireEvent.click(screen.getByRole("button", { name: "Collapse hunk 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand hunk 1" }));
    expect(screen.getByRole("region", { name: "Change hunk 1" }).textContent).toContain("after one");
  });

  it("loads a read-only Monaco hunk view and explains plain-text fallback", async () => {
    const document: DiffDocumentResponse = {
      repoId: "repo_fixture",
      path: "assets/data.unknown",
      revision: "sha256:monaco-fixture",
      originalPath: null,
      scope: "commit",
      changeKind: "modified",
      status: "text",
      hunks: [{
        oldStart: 3,
        oldLines: 2,
        newStart: 3,
        newLines: 2,
        rows: [
          { kind: "context", oldLine: 3, newLine: 3, oldText: "header", newText: "header" },
          { kind: "change", oldLine: 4, newLine: 4, oldText: "old value", newText: "new value" },
        ],
      }],
    };
    render(<SplitDiff document={document} onStageSelection={vi.fn()} disabled={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Monaco view" }));
    expect((await screen.findByTestId("monaco-diff-hunk")).textContent).toBe("plaintext|header\nold value||header\nnew value");
    expect(screen.getByRole("status").textContent).toContain("showing plain text");
  });
});

describe("SplitDiff layouts", () => {
  const document: DiffDocumentResponse = {
    repoId: "repo_fixture",
    path: "src/file.ts",
    revision: "sha256:layouts",
    originalPath: null,
    scope: "workingTree",
    changeKind: "modified",
    status: "text",
    hunks: [{
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      rows: [
        { kind: "context", oldLine: 1, newLine: 1, oldText: "keep", newText: "keep" },
        { kind: "change", oldLine: 2, newLine: 2, oldText: "old two", newText: "new two" },
        { kind: "change", oldLine: null, newLine: 3, oldText: null, newText: "added three" },
        { kind: "change", oldLine: 3, newLine: null, oldText: "removed four", newText: null },
      ],
    }],
  };

  /** The same clicks in either layout: the new side of the paired row, the added line, and the removed line. */
  function stagedWith(layout: "split" | "unified") {
    const onStageSelection = vi.fn();
    render(<SplitDiff layout={layout} document={document} onStageSelection={onStageSelection} disabled={false} />);
    if (layout === "split") {
      fireEvent.click(screen.getByRole("checkbox", { name: "Select only added line 2" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select hunk 1 change row 3" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select hunk 1 change row 4" }));
    } else {
      fireEvent.click(screen.getByRole("checkbox", { name: "Select the added line in hunk 1, row 2" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select the added line in hunk 1, row 3" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select the deleted line in hunk 1, row 4" }));
    }
    fireEvent.click(screen.getByRole("button", { name: /^Stage selected/ }));
    return onStageSelection.mock.calls[0][0];
  }

  it("sends the same selection to staging in both layouts", () => {
    const split = stagedWith("split");
    cleanup();
    const unified = stagedWith("unified");
    expect(unified).toEqual(split);
    expect(split.length).toBeGreaterThan(0);
  });

  it("shows one line per side in the unified layout, with context shown once", () => {
    render(<SplitDiff layout="unified" document={document} onStageSelection={vi.fn()} disabled={false} />);
    expect(screen.getByRole("group", { name: "Deleted line 2: old two" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Added line 2: new two" })).toBeDefined();
    expect(screen.getAllByText("keep")).toHaveLength(1);
  });

  it("selects only the deleted half of a paired row from its own line", () => {
    const onStageSelection = vi.fn();
    render(<SplitDiff layout="unified" document={document} onStageSelection={onStageSelection} disabled={false} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select the deleted line in hunk 1, row 2" }));
    fireEvent.click(screen.getByRole("button", { name: /^Stage selected/ }));
    expect(onStageSelection).toHaveBeenCalledWith([{ hunkIndex: 0, rowIndex: 1, side: "old" }]);
  });

  it("offers no checkboxes in the unified layout when read-only", () => {
    render(<SplitDiff layout="unified" document={{ ...document, scope: "commit" }} onStageSelection={vi.fn()} disabled={false} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
