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
