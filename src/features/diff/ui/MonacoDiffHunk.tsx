import { useI18n } from "../../../shared/i18n";
import { DiffEditor, useMonaco, type Monaco } from "@monaco-editor/react";
import { useEffect, useState } from "react";
import { codeFontStack, hexWithAlpha, useAppearance, type AppearanceSnapshot } from "../../settings";
import { parseDiffHunkSyntax } from "../model/tree-sitter";

const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  javascript: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/javascript/register.js"),
  rust: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/rust/register.js"),
  typescript: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/typescript/register.js"),
};
const registeredLanguages = new Map<string, Promise<unknown>>();
const workerCreators = {
  editor: () => new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" }),
  json: () => new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" }),
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

const definedMonacoThemes = new Set<string>();

function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

/** Defines (once) a Monaco theme matching the active GitCrest palette and returns its name. */
function ensureMonacoTheme(monaco: Monaco | null, { activeTheme }: AppearanceSnapshot): string {
  const { palette, base } = activeTheme;
  const name = `gitcrest-${base}-${hashText(JSON.stringify(palette))}`;
  if (!monaco || definedMonacoThemes.has(name)) return name;
  monaco.editor.defineTheme(name, {
    base: base === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": palette.surface,
      "editor.foreground": palette.text,
      "editorGutter.background": palette.surface,
      "editorLineNumber.foreground": palette.textMuted,
      "editorLineNumber.activeForeground": palette.textSecondary,
      "editor.selectionBackground": hexWithAlpha(palette.accent, 0.28),
      "editor.inactiveSelectionBackground": hexWithAlpha(palette.accent, 0.16),
      "editorWidget.background": palette.surfaceRaised,
      "diffEditor.border": palette.line,
      "diffEditor.insertedLineBackground": hexWithAlpha(palette.gitAdded, 0.1),
      "diffEditor.removedLineBackground": hexWithAlpha(palette.gitDeleted, 0.1),
      "diffEditor.insertedTextBackground": hexWithAlpha(palette.gitAdded, 0.24),
      "diffEditor.removedTextBackground": hexWithAlpha(palette.gitDeleted, 0.24),
      "scrollbarSlider.background": hexWithAlpha(palette.textMuted, 0.22),
      "scrollbarSlider.hoverBackground": hexWithAlpha(palette.textMuted, 0.34),
    },
  });
  definedMonacoThemes.add(name);
  return name;
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
