// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffDocumentResponse } from "../../src/api/client";
import type { SourceDeclaration } from "../../src/features/languages/model/structure-common";
import { SplitDiff } from "../../src/features/diff/ui/SplitDiff";

function declaration(name: string, start: number, end: number): SourceDeclaration {
  return { key: `function:${name}`, kind: "function", name, parentKey: null, range: { start, end }, parameters: "()", parametersRange: { start, end: start }, bodyStart: start, reliable: true };
}

// The grammar itself is covered by code-review-analysis.test.ts; here the parse result is fixed.
vi.mock("../../src/features/diff/model/tree-sitter", () => ({
  parseSourceStructure: async () => ({
    status: "parsed",
    original: [declaration("first", 1, 3), declaration("second", 4, 6)],
    modified: [declaration("first", 1, 3), declaration("second", 4, 6)],
    recovered: false,
  }),
}));

afterEach(cleanup);

const rows: DiffDocumentResponse["hunks"][number]["rows"] = [
  { kind: "context", oldLine: 1, newLine: 1, oldText: "function first() {", newText: "function first() {" },
  { kind: "change", oldLine: 2, newLine: 2, oldText: "  return 1;", newText: "  return 11;" },
  { kind: "context", oldLine: 3, newLine: 3, oldText: "}", newText: "}" },
  { kind: "context", oldLine: 4, newLine: 4, oldText: "function second() {", newText: "function second() {" },
  { kind: "change", oldLine: 5, newLine: 5, oldText: "  return 2;", newText: "  return 22;" },
  { kind: "context", oldLine: 6, newLine: 6, oldText: "}", newText: "}" },
];
const base = { repoId: "repo_fixture", path: "src/first.ts", originalPath: null, scope: "workingTree" as const, changeKind: "modified" as const, status: "text" as const };
const hunksDocument: DiffDocumentResponse = { ...base, revision: "sha256:hunks", hunks: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, rows }] };
const fullDocument: DiffDocumentResponse = { ...base, revision: "sha256:full", hunks: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, rows }] };

describe("SplitDiff structure outline", () => {
  it("selects one function's changed rows from the structure list and stages only them", async () => {
    const onStageSelection = vi.fn();
    render(<SplitDiff
      document={hunksDocument}
      onStageSelection={onStageSelection}
      disabled={false}
      codeReview={{ fullDocument, loading: false, onRefresh: vi.fn(), open: true, onToggle: vi.fn() }}
    />);

    fireEvent.click(await screen.findByRole("treeitem", { name: /first\(\)/ }));
    expect(screen.getByRole("group", { name: "What changed" }).textContent).toBe("Body");
    fireEvent.click(screen.getByRole("button", { name: "Select its changes" }));

    expect((screen.getByRole("checkbox", { name: "Select hunk 1 change row 2" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Select hunk 1 change row 5" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/changed rows: 1, in first\(\)/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Stage selected changes" }));
    expect(onStageSelection).toHaveBeenCalledWith([{ hunkIndex: 0, rowIndex: 1 }]);

    fireEvent.click(screen.getByRole("button", { name: "Deselect its changes" }));
    expect((screen.getByRole("checkbox", { name: "Select hunk 1 change row 2" }) as HTMLInputElement).checked).toBe(false);
  });

  it("keeps a historical diff's structure list read-only", async () => {
    render(<SplitDiff
      document={{ ...hunksDocument, scope: "commit" }}
      onStageSelection={vi.fn()}
      disabled
      codeReview={{ fullDocument: { ...fullDocument, scope: "commit" }, loading: false, onRefresh: vi.fn(), open: true, onToggle: vi.fn() }}
    />);

    fireEvent.click(await screen.findByRole("treeitem", { name: /second\(\)/ }));
    expect(screen.queryByRole("button", { name: /Select its changes|Mark reviewed/ })).toBeNull();
  });

  it("asks for a refresh when the full file no longer matches the hunks", async () => {
    const stale = { ...fullDocument, hunks: [{ ...fullDocument.hunks[0]!, rows: rows.map((row) => row.newLine === 5 ? { ...row, newText: "  return 23;" } : row) }] };
    const onRefresh = vi.fn();
    render(<SplitDiff document={hunksDocument} onStageSelection={vi.fn()} disabled={false} codeReview={{ fullDocument: stale, loading: false, onRefresh, open: true, onToggle: vi.fn() }} />);

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalled();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("stages one side of a paired row and names each hunk's structures", async () => {
    const onStageSelection = vi.fn();
    render(<SplitDiff document={hunksDocument} onStageSelection={onStageSelection} disabled={false} codeReview={{ fullDocument, loading: false, onRefresh: vi.fn(), open: true, onToggle: vi.fn() }} />);

    expect((await screen.findByText("first() · second()")).className).toBe("hunkStructures");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select only added line 2" }));
    const row = screen.getByRole("checkbox", { name: "Select hunk 1 change row 2" }) as HTMLInputElement;
    expect(row.checked).toBe(false);
    expect(row.indeterminate).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stage selected changes" }));
    expect(onStageSelection).toHaveBeenLastCalledWith([{ hunkIndex: 0, rowIndex: 1, side: "new" }]);

    // Selecting the other side too makes the whole row, and both rows make the whole hunk.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select only deleted line 2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select hunk 1 change row 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage selected changes" }));
    expect(onStageSelection).toHaveBeenLastCalledWith([{ hunkIndex: 0 }]);
  });

  it("flags selected debug output and deselects it on request", async () => {
    const debugRows: DiffDocumentResponse["hunks"][number]["rows"] = [
      { kind: "context", oldLine: 1, newLine: 1, oldText: "function first() {", newText: "function first() {" },
      { kind: "change", oldLine: null, newLine: 2, oldText: null, newText: "  console.log(\"here\");" },
      { kind: "change", oldLine: 2, newLine: 3, oldText: "  return 1;", newText: "  return 11;" },
      { kind: "context", oldLine: 3, newLine: 4, oldText: "}", newText: "}" },
    ];
    const hunks = { ...hunksDocument, revision: "sha256:debug-hunks", hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, rows: debugRows }] };
    const full = { ...fullDocument, revision: "sha256:debug-full", hunks: hunks.hunks };
    const onStageSelection = vi.fn();
    render(<SplitDiff document={hunks} onStageSelection={onStageSelection} disabled={false} codeReview={{ fullDocument: full, loading: false, onRefresh: vi.fn(), open: true, onToggle: vi.fn() }} />);

    await screen.findByRole("tree");
    expect(screen.getByText("debug")).toBeDefined();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select hunk 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Deselect them" }));
    expect(screen.queryByText("Selected debug lines: 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stage selected changes" }));
    expect(onStageSelection).toHaveBeenLastCalledWith([{ hunkIndex: 0, rowIndex: 2 }]);
  });

  it("counts review progress and moves to the next unreviewed structure", async () => {
    render(<SplitDiff document={hunksDocument} onStageSelection={vi.fn()} disabled={false} codeReview={{ fullDocument: { ...fullDocument, path: "src/progress.ts" }, loading: false, onRefresh: vi.fn(), open: true, onToggle: vi.fn() }} />);

    expect(await screen.findByText("Reviewed 0 / 2")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Next unreviewed" }));
    expect(screen.getByRole("treeitem", { name: /first\(\)/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(screen.getByText("Reviewed 1 / 2")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Next unreviewed" }));
    expect(screen.getByRole("treeitem", { name: /second\(\)/ }).getAttribute("aria-selected")).toBe("true");
  });
});
