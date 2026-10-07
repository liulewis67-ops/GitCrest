import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useState } from "react";
import { parseDiffHunkSyntax } from "./tree-sitter";

const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  javascript: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/javascript/register.js"),
  rust: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/rust/register.js"),
  typescript: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/typescript/register.js"),
};
const registeredLanguages = new Map<string, Promise<unknown>>();
const workerCreators = {
  editor: () => new Worker(new URL("../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" }),
  json: () => new Worker(new URL("../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" }),
};

function loadLanguage(language: string): Promise<unknown> {
  const loader = LANGUAGE_LOADERS[language];
  if (!loader) return Promise.resolve();
  const existing = registeredLanguages.get(language);
  if (existing) return existing;
  const loading = loader();
  registeredLanguages.set(language, loading);
  return loading;
}

const monacoGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment?: { getWorker: (_moduleId: string, _label: string) => Worker };
};

monacoGlobal.MonacoEnvironment ??= {
  getWorker: (_moduleId, label) => {
    const createWorker = label === "json"
      ? workerCreators.json
      : workerCreators.editor;
    return createWorker();
  },
};

interface MonacoDiffHunkProps {
  original: string;
  modified: string;
  language: string;
  treeSitterGrammar: string | null;
  label: string;
  height: number;
}

export function MonacoDiffHunk({ original, modified, language, treeSitterGrammar, label, height }: MonacoDiffHunkProps) {
  const [languageReady, setLanguageReady] = useState(language === "plaintext");
  const [languageFailed, setLanguageFailed] = useState(false);
  const [parseState, setParseState] = useState<"loading" | "parsed" | "recovered" | "language" | "tooLarge" | "parserUnavailable">(treeSitterGrammar ? "loading" : "language");
  useEffect(() => {
    let cancelled = false;
    setLanguageReady(language === "plaintext");
    setLanguageFailed(false);
    void loadLanguage(language).then(() => {
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

  if (!languageReady || parseState === "loading") return <div className="monacoDiffLoading" role="status">Loading syntax support…</div>;
  const themePreference = document.documentElement.dataset.theme;
  const prefersDark = themePreference === "dark" || (themePreference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <div className="monacoDiffHunk" aria-label={label} data-tree-sitter-state={parseState}>
      {languageFailed && <div className="diffSyntaxFallback" role="status">Syntax support failed to load. Monaco is showing plain text.</div>}
      {treeSitterGrammar && parseState === "parserUnavailable" && <div className="diffSyntaxFallback" role="status">Tree-sitter could not load this grammar. Monaco is showing plain text.</div>}
      {parseState === "tooLarge" && <div className="diffSyntaxFallback" role="status">This hunk is too large for syntax parsing. Monaco is showing plain text.</div>}
      {parseState === "recovered" && <div className="diffSyntaxFallback" role="status">This hunk is a partial excerpt; tree-sitter recovered from incomplete context.</div>}
      <DiffEditor
        height={`${height}px`}
        language={languageFailed || parseState === "language" || parseState === "tooLarge" || parseState === "parserUnavailable" ? "plaintext" : language}
        original={original}
        modified={modified}
        theme={prefersDark ? "vs-dark" : "vs"}
        options={{
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
