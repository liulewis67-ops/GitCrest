import { describe, expect, it } from "vitest";
import { monacoLanguageForPath } from "../../src/features/diff/model/monaco-language";

describe("monacoLanguageForPath", () => {
  it("recognizes common source paths regardless of directory separators or case", () => {
    expect(monacoLanguageForPath("src/components/Panel.TSX")).toEqual({ id: "typescript", treeSitterGrammar: "tsx", supported: true });
    expect(monacoLanguageForPath("src\\core\\lib.rs")).toEqual({ id: "rust", treeSitterGrammar: "rust", supported: true });
    expect(monacoLanguageForPath("src/app.js")).toEqual({ id: "javascript", treeSitterGrammar: "javascript", supported: true });
    expect(monacoLanguageForPath("data/config.json")).toEqual({ id: "json", treeSitterGrammar: "json", supported: true });
    expect(monacoLanguageForPath("tools/Build.CS")).toEqual({ id: "csharp", treeSitterGrammar: "csharp", supported: true });
  });

  it("falls back to plain text for extensionless and unsupported files", () => {
    expect(monacoLanguageForPath("LICENSE")).toEqual({ id: "plaintext", treeSitterGrammar: null, supported: false });
    expect(monacoLanguageForPath("assets/image.avif")).toEqual({ id: "plaintext", treeSitterGrammar: null, supported: false });
    // Markdown structure is read without a grammar, so its hunks keep the plain-text check.
    expect(monacoLanguageForPath("README.md")).toEqual({ id: "plaintext", treeSitterGrammar: null, supported: false });
  });
});
