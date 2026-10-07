import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useState } from "react";

const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  c: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/cpp/register.js"),
  cpp: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/cpp/register.js"),
  csharp: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/csharp/register.js"),
  css: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/css/register.js"),
  go: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/go/register.js"),
  html: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/html/register.js"),
  java: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/java/register.js"),
  javascript: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/javascript/register.js"),
  json: () => import("../../../node_modules/monaco-editor/esm/vs/language/json/monaco.contribution.js"),
  markdown: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/markdown/register.js"),
  python: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/python/register.js"),
  rust: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/rust/register.js"),
  scss: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/scss/register.js"),
  shell: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/shell/register.js"),
  sql: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/sql/register.js"),
  typescript: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/typescript/register.js"),
  xml: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/xml/register.js"),
  yaml: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/yaml/register.js"),
  ini: () => import("../../../node_modules/monaco-editor/esm/vs/languages/definitions/ini/register.js"),
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
  label: string;
  height: number;
}

export function MonacoDiffHunk({ original, modified, language, label, height }: MonacoDiffHunkProps) {
  const [languageReady, setLanguageReady] = useState(language === "plaintext");
  const [languageFailed, setLanguageFailed] = useState(false);
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

  if (!languageReady) return <div className="monacoDiffLoading" role="status">Loading syntax support…</div>;
  const themePreference = document.documentElement.dataset.theme;
  const prefersDark = themePreference === "dark" || (themePreference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <div className="monacoDiffHunk" aria-label={label}>
      {languageFailed && <div className="diffSyntaxFallback" role="status">Syntax support failed to load. Monaco is showing plain text.</div>}
      <DiffEditor
        height={`${height}px`}
        language={languageFailed ? "plaintext" : language}
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
