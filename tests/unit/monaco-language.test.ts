import { describe, expect, it } from "vitest";
import { monacoLanguageForPath } from "../../src/features/diff/monaco-language";

describe("monacoLanguageForPath", () => {
  it("recognizes common source paths regardless of directory separators or case", () => {
    expect(monacoLanguageForPath("src/components/Panel.TSX")).toEqual({ id: "typescript", supported: true });
    expect(monacoLanguageForPath("src\\core\\lib.rs")).toEqual({ id: "rust", supported: true });
  });

  it("falls back to plain text for extensionless and unsupported files", () => {
    expect(monacoLanguageForPath("LICENSE")).toEqual({ id: "plaintext", supported: false });
    expect(monacoLanguageForPath("assets/image.avif")).toEqual({ id: "plaintext", supported: false });
  });
});
