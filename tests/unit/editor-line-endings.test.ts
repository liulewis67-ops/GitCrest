import { expect, it } from "vitest";
import { applyEditorChanges, lineEndingSignature, restoreLineEndings } from "../../src/features/workflows/model/editor-line-endings";

it("edits one line without normalizing untouched mixed line endings", () => {
  const raw = "top\r\nold\nbottom\r\nend";
  const changed = applyEditorChanges(raw, [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, text: "new" }]);
  expect(changed).toBe("top\r\nnew\nbottom\r\nend");
  expect(restoreLineEndings(changed.replace(/\r?\n/g, "\n"), lineEndingSignature(raw))).toBe(changed);
});
it("maps multi-range edits against the same prior raw document", () => {
  const raw = "first\r\nsecond\nthird";
  expect(applyEditorChanges(raw, [
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, text: "one" },
    { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 6 }, text: "three" },
  ])).toBe("one\r\nsecond\nthree");
});
