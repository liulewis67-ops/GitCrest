// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BlameDocumentResponse } from "../../src/api/client";
import { BlameView } from "../../src/features/diff/ui/DiffWindow";
import { setLocale } from "../../src/shared/i18n";

afterEach(() => {
  cleanup();
  act(() => setLocale("en"));
});

const committedAtMs = new Date(2024, 2, 3, 1, 23).getTime();
const document: BlameDocumentResponse = {
  repoId: "repo_fixture",
  path: "src/job.ts",
  revision: null,
  lines: [
    { lineNumber: 1, originalLineNumber: 1, commitOid: "0794f659aa".padEnd(40, "0"), authorName: "canghe", authorEmail: "canghe@example.com", committedAtMs, summary: "Initialize the project", text: "export const job = true;" },
    { lineNumber: 2, originalLineNumber: 2, commitOid: "0".repeat(40), authorName: "Not Committed Yet", authorEmail: "not.committed.yet", committedAtMs, summary: "Version of src/job.ts from src/job.ts", text: "// new line" },
  ],
};

describe("BlameView", () => {
  it("annotates each line with only its date and author, then its number and code", () => {
    act(() => setLocale("zh"));
    render(<BlameView document={document} />);
    const rows = screen.getByLabelText("src/job.ts 的逐行追溯").querySelectorAll(".blameLine");
    expect([...rows[0].children].map((cell) => cell.textContent)).toEqual(["2024/3/3canghe", "1", "export const job = true;"]);
    expect(rows[1].querySelector(".blameAuthor")?.textContent).toBe("Not Committed Yet");
    // The commit and its subject are no longer columns; they stay in the annotation's tooltip.
    expect(screen.queryByText("0794f659")).toBeNull();
    expect(screen.queryByText("Initialize the project")).toBeNull();
    const annotation = rows[0].querySelector(".blameAnnotation");
    expect(annotation?.getAttribute("title")).toContain("0794f659 Initialize the project");
    expect(annotation?.getAttribute("title")).toContain("canghe <canghe@example.com>");
  });
});
