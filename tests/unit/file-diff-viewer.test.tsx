// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffDocumentResponse } from "../../src/api/client";
import { fullFileSides } from "../../src/features/diff/model/full-file-diff";
import { monacoHighlightLanguageForPath } from "../../src/features/diff/model/monaco-language";
import { DEFAULT_DIFF_VIEW_PREFERENCES, readDiffViewPreferences } from "../../src/features/diff/model/use-diff-view-preferences";
import { FileDiffViewer } from "../../src/features/diff/ui/FileDiffViewer";

vi.mock("../../src/features/diff/ui/MonacoFileDiff", () => ({
  MonacoFileDiff: (props: { original: string; modified: string; language: string; sideBySide: boolean; ignoreWhitespace: boolean; label: string }) => createElement(
    "pre",
    { "aria-label": props.label, "data-side-by-side": String(props.sideBySide), "data-ignore-whitespace": String(props.ignoreWhitespace) },
    `${props.language}|${props.original}||${props.modified}`,
  ),
}));

afterEach(cleanup);

function fullDocument(overrides: Partial<DiffDocumentResponse> = {}): DiffDocumentResponse {
  return {
    repoId: "repo_fixture",
    path: "config/bootstrap.yml",
    revision: "sha256:full-fixture",
    originalPath: null,
    scope: "commit",
    changeKind: "modified",
    status: "text",
    hunks: [{
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      rows: [
        { kind: "context", oldLine: 1, newLine: 1, oldText: "sentinel:", newText: "sentinel:" },
        { kind: "change", oldLine: 2, newLine: 2, oldText: "  dashboard: 127.0.0.1:8080", newText: "  dashboard: 127.0.0.1:8083" },
        { kind: "change", oldLine: 3, newLine: null, oldText: "  removed: true", newText: null },
        { kind: "context", oldLine: 4, newLine: 3, oldText: "  port: 8719", newText: "  port: 8719" },
      ],
    }],
    ...overrides,
  };
}

describe("fullFileSides", () => {
  it("rebuilds both complete files from a full-context hunk", () => {
    expect(fullFileSides(fullDocument())).toEqual({
      original: "sentinel:\n  dashboard: 127.0.0.1:8080\n  removed: true\n  port: 8719",
      modified: "sentinel:\n  dashboard: 127.0.0.1:8083\n  port: 8719",
    });
  });
});

describe("monacoHighlightLanguageForPath", () => {
  it("colours common file types beyond the tree-sitter grammars", () => {
    expect(monacoHighlightLanguageForPath("src/main.ts")).toBe("typescript");
    expect(monacoHighlightLanguageForPath("config/bootstrap.yml")).toBe("yaml");
    expect(monacoHighlightLanguageForPath("pmhub/TaskJob.java")).toBe("java");
    expect(monacoHighlightLanguageForPath("docker/Dockerfile")).toBe("dockerfile");
    expect(monacoHighlightLanguageForPath("notes.unknown")).toBe("plaintext");
  });
});

describe("readDiffViewPreferences", () => {
  it("falls back to the full-file defaults for missing or malformed values", () => {
    expect(readDiffViewPreferences(null)).toEqual(DEFAULT_DIFF_VIEW_PREFERENCES);
    expect(readDiffViewPreferences("{not json")).toEqual(DEFAULT_DIFF_VIEW_PREFERENCES);
    expect(readDiffViewPreferences(JSON.stringify({ layout: "hunks", sideBySide: "yes", ignoreWhitespace: true }))).toEqual({
      ...DEFAULT_DIFF_VIEW_PREFERENCES,
      layout: "hunks",
      ignoreWhitespace: true,
    });
  });
});

describe("FileDiffViewer", () => {
  it("labels a commit comparison against its first parent and passes both whole files to the editor", async () => {
    render(<FileDiffViewer
      document={fullDocument()}
      commitOid={"2be2d75".padEnd(40, "0")}
      preferences={DEFAULT_DIFF_VIEW_PREFERENCES}
      onChangePreferences={vi.fn()}
      onShowHunks={vi.fn()}
    />);

    const editor = await screen.findByLabelText("Side-by-side comparison of config/bootstrap.yml");
    expect(editor.textContent).toBe("yaml|sentinel:\n  dashboard: 127.0.0.1:8080\n  removed: true\n  port: 8719||sentinel:\n  dashboard: 127.0.0.1:8083\n  port: 8719");
    expect(screen.getByText("2be2d75^")).toBeDefined();
    expect(screen.getByText("2be2d75")).toBeDefined();
    expect(screen.getByRole("button", { name: "Hunks" })).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("changes layout and whitespace preferences and offers hunks for line selection", async () => {
    const onChangePreferences = vi.fn();
    const onShowHunks = vi.fn();
    render(<FileDiffViewer
      document={fullDocument({ scope: "workingTree" })}
      preferences={DEFAULT_DIFF_VIEW_PREFERENCES}
      onChangePreferences={onChangePreferences}
      onShowHunks={onShowHunks}
    />);
    await screen.findByLabelText("Side-by-side comparison of config/bootstrap.yml");
    expect(screen.getByText("Staged version")).toBeDefined();
    expect(screen.getByText("Your version")).toBeDefined();

    fireEvent.change(screen.getByRole("combobox", { name: "Diff layout" }), { target: { value: "unified" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Whitespace" }), { target: { value: "ignore" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse unchanged" }));
    fireEvent.click(screen.getByRole("button", { name: "Select lines…" }));

    expect(onChangePreferences.mock.calls).toEqual([[{ sideBySide: false }], [{ ignoreWhitespace: true }], [{ collapseUnchanged: true }]]);
    expect(onShowHunks).toHaveBeenCalledTimes(1);
  });

  it("falls back to hunks when the whole file is too large for the editor", () => {
    const onShowHunks = vi.fn();
    const huge = "x".repeat(600_000);
    render(<FileDiffViewer
      document={fullDocument({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: huge, newText: `${huge}y` }] }] })}
      preferences={DEFAULT_DIFF_VIEW_PREFERENCES}
      onChangePreferences={vi.fn()}
      onShowHunks={onShowHunks}
    />);

    expect(screen.getByText(/too large to compare in full/)).toBeDefined();
    expect(screen.queryByLabelText("Side-by-side comparison of config/bootstrap.yml")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Hunks" })[1]!);
    expect(onShowHunks).toHaveBeenCalledTimes(1);
  });

  it("explains files without text instead of opening the editor", () => {
    render(<FileDiffViewer
      document={fullDocument({ status: "binary", hunks: [] })}
      preferences={DEFAULT_DIFF_VIEW_PREFERENCES}
      onChangePreferences={vi.fn()}
      onShowHunks={vi.fn()}
    />);
    expect(screen.getByText(/This file is binary/)).toBeDefined();
  });
});
