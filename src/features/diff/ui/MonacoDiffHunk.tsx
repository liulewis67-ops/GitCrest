import { useI18n } from "../../../shared/i18n";
import { DiffEditor, useMonaco, type MonacoDiffEditor } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { codeFontStack, useAppearance } from "../../settings";
import { parseDiffHunkSyntax } from "../model/tree-sitter";
import { ensureMonacoTheme, loadMonacoLanguage } from "./monaco-setup";

interface MonacoDiffHunkProps {
  original: string;
  modified: string;
  language: string;
  treeSitterGrammar: string | null;
  label: string;
  height: number;
  /** Blame for each line of `modified`, drawn before its line number; empty strings leave a line blank. */
  modifiedGutter?: string[];
}

// Monaco's default width of the line-number gutter, in characters.
const DEFAULT_LINE_NUMBER_CHARS = 5;

/** Monaco's gutter only draws text, so blame is written into the new side's line numbers, padded to line up. */
function applyModifiedGutter(diffEditor: MonacoDiffEditor, gutter: string[] | undefined) {
  const modifiedEditor = diffEditor.getModifiedEditor();
  if (!gutter) {
    modifiedEditor.updateOptions({ lineNumbers: "on", lineNumbersMinChars: DEFAULT_LINE_NUMBER_CHARS });
    return;
  }
  const labelWidth = gutter.reduce((width, label) => Math.max(width, label.length), 0);
  const numberWidth = String(Math.max(gutter.length, 1)).length;
  modifiedEditor.updateOptions({
    lineNumbers: (lineNumber) => `${(gutter[lineNumber - 1] ?? "").padEnd(labelWidth)}  ${lineNumber}`,
    lineNumbersMinChars: labelWidth + 2 + numberWidth,
  });
}

export function MonacoDiffHunk({ original, modified, language, treeSitterGrammar, label, height, modifiedGutter }: MonacoDiffHunkProps) {
  const { t } = useI18n();
  const appearance = useAppearance();
  const monaco = useMonaco();
  const [languageReady, setLanguageReady] = useState(language === "plaintext");
  const [languageFailed, setLanguageFailed] = useState(false);
  const [parseState, setParseState] = useState<"loading" | "parsed" | "recovered" | "language" | "tooLarge" | "parserUnavailable">(treeSitterGrammar ? "loading" : "language");
  const diffEditorRef = useRef<MonacoDiffEditor>();
  const gutterRef = useRef(modifiedGutter);
  gutterRef.current = modifiedGutter;
  useEffect(() => {
    if (diffEditorRef.current) applyModifiedGutter(diffEditorRef.current, modifiedGutter);
  }, [modifiedGutter]);
  useEffect(() => {
    let cancelled = false;
    setLanguageReady(language === "plaintext");
    setLanguageFailed(false);
    void loadMonacoLanguage(language).then(() => {
      if (!cancelled) setLanguageReady(true);
    }).catch(() => {
      if (!cancelled) {
        setLanguageFailed(true);
        setLanguageReady(true);
      }
    });
    return () => { cancelled = true; };
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    setParseState(treeSitterGrammar ? "loading" : "language");
    void parseDiffHunkSyntax(treeSitterGrammar, original, modified).then((result) => {
      if (cancelled) return;
      setParseState(result.status === "unsupported" ? result.reason : result.recovered ? "recovered" : "parsed");
    });
    return () => { cancelled = true; };
  }, [treeSitterGrammar, original, modified]);

  if (!languageReady || parseState === "loading") return <div className="monacoDiffLoading" role="status">{t("mz.loading")}</div>;
  // Defined during render so the theme exists before DiffEditor switches to it.
  const monacoTheme = ensureMonacoTheme(monaco, appearance);
  const codeSize = appearance.typography.codeFontSize;
  return (
    <div className="monacoDiffHunk" aria-label={label} data-tree-sitter-state={parseState}>
      {languageFailed && <div className="diffSyntaxFallback" role="status">{t("mz.loadFailed")}</div>}
      {treeSitterGrammar && parseState === "parserUnavailable" && <div className="diffSyntaxFallback" role="status">{t("mz.grammar")}</div>}
      {parseState === "tooLarge" && <div className="diffSyntaxFallback" role="status">{t("mz.tooLarge")}</div>}
      {parseState === "recovered" && <div className="diffSyntaxFallback" role="status">{t("mz.recovered")}</div>}
      <DiffEditor
        height={`${height}px`}
        language={languageFailed || parseState === "language" || parseState === "tooLarge" || parseState === "parserUnavailable" ? "plaintext" : language}
        original={original}
        modified={modified}
        theme={monacoTheme}
        beforeMount={(instance) => { ensureMonacoTheme(instance, appearance); }}
        onMount={(diffEditor) => {
          diffEditorRef.current = diffEditor;
          applyModifiedGutter(diffEditor, gutterRef.current);
        }}
        options={{
          fontFamily: codeFontStack(appearance.typography),
          fontSize: codeSize,
          lineHeight: Math.round(codeSize * 1.54),
          automaticLayout: true,
          diffAlgorithm: "advanced",
          ignoreTrimWhitespace: false,
          lineNumbers: "on",
          minimap: { enabled: false },
          originalEditable: false,
          readOnly: true,
          renderSideBySide: true,
          scrollBeyondLastLine: false,
          wordWrap: "on",
        }}
      />
    </div>
  );
}
