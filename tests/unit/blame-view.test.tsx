// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlameDocumentResponse, DiffDocumentResponse } from "../../src/api/client";
import { createBlameLookup } from "../../src/features/diff/ui/BlameAnnotation";
import { SplitDiff } from "../../src/features/diff/ui/SplitDiff";
import { UnifiedDiff } from "../../src/features/diff/ui/DiffWindow";
import { setLocale } from "../../src/shared/i18n";

vi.mock("../../src/features/diff/ui/MonacoDiffHunk", () => ({
  MonacoDiffHunk: (props: { modified: string; modifiedGutter?: string[] }) => createElement("pre", { "data-testid": "monaco-diff-hunk", "data-gutter": JSON.stringify(props.modifiedGutter ?? null) }, props.modified),
}));

afterEach(() => {
  cleanup();
  act(() => setLocale("en"));
});

const committedAtMs = new Date(2024, 2, 3, 1, 23).getTime();
const commit = "0794f659aa".padEnd(40, "0");
// The working tree's blame: line 2 is not committed yet.
const blame: BlameDocumentResponse = {
  repoId: "repo_fixture",
  path: "src/job.ts",
  revision: null,
  lines: [
    { lineNumber: 1, originalLineNumber: 1, commitOid: commit, authorName: "canghe", authorEmail: "canghe@example.com", committedAtMs, summary: "Initialize the project", text: "export const job = true;" },
    { lineNumber: 2, originalLineNumber: 2, commitOid: "0".repeat(40), authorName: "Not Committed Yet", authorEmail: "not.committed.yet", committedAtMs, summary: "Version of src/job.ts from src/job.ts", text: "export const added = 1;" },
    { lineNumber: 3, originalLineNumber: 2, commitOid: commit, authorName: "canghe", authorEmail: "canghe@example.com", committedAtMs, summary: "Initialize the project", text: "export const kept = 2;\r" },
  ],
};
const diff: DiffDocumentResponse = {
  repoId: "repo_fixture",
  path: "src/job.ts",
  revision: "sha256:working-tree",
  originalPath: null,
  scope: "workingTree",
  changeKind: "modified",
  status: "text",
  hunks: [{
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    rows: [
      { kind: "context", oldLine: 1, newLine: 1, oldText: "export const job = true;", newText: "export const job = true;" },
      { kind: "change", oldLine: 2, newLine: 2, oldText: "export const removed = 0;", newText: "export const added = 1;" },
      { kind: "context", oldLine: 3, newLine: 3, oldText: "export const kept = 2;", newText: "export const kept = 2;" },
    ],
  }],
};

describe("createBlameLookup", () => {
  it("annotates a line only while its text matches and a commit owns it", () => {
    const lookup = createBlameLookup(blame);
    expect(lookup(1, "export const job = true;")?.authorName).toBe("canghe");
    // A carriage return left by a CRLF file does not count as a difference.
    expect(lookup(3, "export const kept = 2;")?.authorName).toBe("canghe");
    // Uncommitted lines stay blank, as do lines whose text no longer matches (a staged side blamed from the working tree).
    expect(lookup(2, "export const added = 1;")).toBeUndefined();
    expect(lookup(1, "export const job = false;")).toBeUndefined();
    expect(lookup(null, "export const job = true;")).toBeUndefined();
    expect(lookup(9, "missing")).toBeUndefined();
  });
});

describe("Blame in the Diff window layouts", () => {
  it("puts the date and author before the new side's line number in split view", () => {
    act(() => setLocale("zh"));
    render(<SplitDiff document={diff} onStageSelection={() => undefined} disabled readOnly showFileMeta={false} blame={createBlameLookup(blame)} />);
    // Each row is: selection gutter, old cell, new cell.
    const rows = [...document.querySelectorAll(".splitDiffRow")];
    const [oldCell, newCell] = [rows[0].children[1], rows[0].children[2]];
    expect(newCell.className).toContain("withBlame");
    expect([...newCell.children].map((cell) => cell.textContent)).toEqual(["2024/3/3canghe", "1", "export const job = true;"]);
    expect(newCell.querySelector(".blameAnnotation")?.getAttribute("title")).toContain("0794f659 Initialize the project");
    expect(oldCell.querySelector(".blameAnnotation")).toBeNull();
    // The uncommitted line keeps its column, blank; the CRLF line is still annotated.
    expect(rows[1].children[2].querySelector(".blameAnnotation")?.textContent).toBe("");
    expect(rows[2].children[2].querySelector(".blameAnnotation")?.textContent).toBe("2024/3/3canghe");
  });

  it("leads every unified row with the annotation, blank on deleted and uncommitted lines", () => {
    // In English the short date follows the system's locale.
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(committedAtMs);
    render(<UnifiedDiff document={diff} blame={createBlameLookup(blame)} />);
    expect(screen.getByLabelText("Unified diff for src/job.ts").className).toContain("withBlame");
    const annotation = (name: string) => screen.getByRole("group", { name }).firstElementChild;
    expect(annotation("Context line 1: export const job = true;")?.textContent).toBe(`${day}canghe`);
    expect(annotation("Deleted line 2: export const removed = 0;")?.className).toBe("blameAnnotation");
    expect(annotation("Deleted line 2: export const removed = 0;")?.textContent).toBe("");
    expect(annotation("Added line 2: export const added = 1;")?.textContent).toBe("");
    expect(annotation("Context line 3: export const kept = 2;")?.textContent).toBe(`${day}canghe`);
  });

  it("labels Monaco's new-side lines in order, blank where the split cells are blank", async () => {
    act(() => setLocale("zh"));
    const { rerender } = render(<SplitDiff document={diff} onStageSelection={() => undefined} disabled readOnly showFileMeta={false} blame={createBlameLookup(blame)} />);
    fireEvent.click(screen.getByRole("button", { name: "Monaco 视图" }));
    const hunk = await screen.findByTestId("monaco-diff-hunk");
    expect(JSON.parse(hunk.getAttribute("data-gutter") ?? "null")).toEqual(["2024/3/3 canghe", "", "2024/3/3 canghe"]);

    rerender(<SplitDiff document={diff} onStageSelection={() => undefined} disabled readOnly showFileMeta={false} />);
    expect(screen.getByTestId("monaco-diff-hunk").getAttribute("data-gutter")).toBe("null");
  });

  it("leaves both layouts unchanged while blame is off", () => {
    render(<UnifiedDiff document={diff} />);
    expect(document.querySelector(".blameAnnotation")).toBeNull();
    expect(screen.getByLabelText("Unified diff for src/job.ts").className).toBe("unifiedDiff");
  });
});
