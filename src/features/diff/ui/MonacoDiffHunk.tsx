import { useI18n } from "../../../shared/i18n";
import { DiffEditor, useMonaco } from "@monaco-editor/react";
import { useEffect, useState } from "react";
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
}

export function MonacoDiffHunk({ original, modified, language, treeSitterGrammar, label, height }: MonacoDiffHunkProps) {
  const { t } = useI18n();
  const appearance = useAppearance();
  const monaco = useMonaco();
  const [languageReady, setLanguageReady] = useState(language === "plaintext");
  const [languageFailed, setLanguageFailed] = useState(false);
  const [parseState, setParseState] = useState<"loading" | "parsed" | "recovered" | "language" | "tooLarge" | "parserUnavailable">(treeSitterGrammar ? "loading" : "language");
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
