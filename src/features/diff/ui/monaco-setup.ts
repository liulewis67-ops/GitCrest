import { loader, type Monaco } from "@monaco-editor/react";
import * as monaco from "../../../../node_modules/monaco-editor/esm/vs/editor/editor.api.js";
// The Diff views are read-only, so only the editor features a reader uses are registered on the bundled core.
import "../../../../node_modules/monaco-editor/esm/vs/features/codicon/register.js";
import "../../../../node_modules/monaco-editor/esm/vs/features/diffEditor/register.js";
import "../../../../node_modules/monaco-editor/esm/vs/features/find/register.js";
import "../../../../node_modules/monaco-editor/esm/vs/features/clipboard/register.js";
import "../../../../node_modules/monaco-editor/esm/vs/features/contextmenu/register.js";
import "../../../../node_modules/monaco-editor/esm/vs/features/folding/register.js";
import "../../../../node_modules/monaco-editor/esm/vs/features/bracketMatching/register.js";
import "../../../../node_modules/monaco-editor/esm/vs/features/wordHighlighter/register.js";
import "../../../../node_modules/monaco-editor/esm/vs/features/readOnlyMessage/register.js";
import { hexWithAlpha, type AppearanceSnapshot, type ThemePalette } from "../../settings";

// Left alone, @monaco-editor/react fetches a second, complete Monaco from a CDN, which also fails offline.
// Every Diff uses the bundled one instead: the instance the language loaders below register with.
loader.config({ monaco });

const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  bat: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/bat/register.js"),
  cpp: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/cpp/register.js"),
  csharp: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/csharp/register.js"),
  css: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/css/register.js"),
  dart: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/dart/register.js"),
  dockerfile: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/dockerfile/register.js"),
  go: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/go/register.js"),
  graphql: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/graphql/register.js"),
  html: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/html/register.js"),
  ini: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/ini/register.js"),
  java: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/java/register.js"),
  javascript: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/javascript/register.js"),
  json: () => import("../../../../node_modules/monaco-editor/esm/vs/language/json/monaco.contribution.js"),
  kotlin: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/kotlin/register.js"),
  less: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/less/register.js"),
  lua: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/lua/register.js"),
  markdown: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/markdown/register.js"),
  php: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/php/register.js"),
  powershell: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/powershell/register.js"),
  protobuf: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/protobuf/register.js"),
  python: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/python/register.js"),
  ruby: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/ruby/register.js"),
  rust: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/rust/register.js"),
  scala: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/scala/register.js"),
  scss: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/scss/register.js"),
  shell: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/shell/register.js"),
  sql: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/sql/register.js"),
  swift: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/swift/register.js"),
  typescript: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/typescript/register.js"),
  xml: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/xml/register.js"),
  yaml: () => import("../../../../node_modules/monaco-editor/esm/vs/languages/definitions/yaml/register.js"),
};
const registeredLanguages = new Map<string, Promise<unknown>>();
const workerCreators = {
  editor: () => new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" }),
  json: () => new Worker(new URL("../../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" }),
};

export function loadMonacoLanguage(language: string): Promise<unknown> {
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

/** Monaco token scopes for each theme syntax color. Scopes match by prefix, so `string` also covers `string.escape`. */
function syntaxRules(palette: ThemePalette) {
  const scopes: Array<[keyof ThemePalette, string[]]> = [
    ["syntaxComment", ["comment"]],
    ["syntaxKeyword", ["keyword", "storage"]],
    ["syntaxString", ["string", "regexp", "attribute.value"]],
    ["syntaxNumber", ["number", "constant"]],
    ["syntaxType", ["type", "namespace", "predefined"]],
    ["syntaxTag", ["tag", "metatag", "attribute.name", "string.key", "variable.predefined"]],
  ];
  return scopes.flatMap(([token, tokens]) => tokens.map((scope) => ({ token: scope, foreground: palette[token].slice(1) })));
}

/** Defines (once) a Monaco theme matching the active GitCrest palette and returns its name. */
export function ensureMonacoTheme(monaco: Monaco | null, { activeTheme }: AppearanceSnapshot): string {
  const { palette, base } = activeTheme;
  const name = `gitcrest-${base}-${hashText(JSON.stringify(palette))}`;
  if (!monaco || definedMonacoThemes.has(name)) return name;
  monaco.editor.defineTheme(name, {
    base: base === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: syntaxRules(palette),
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
      "diffEditor.unchangedRegionBackground": palette.surfaceRaised,
      "diffEditor.unchangedRegionForeground": palette.textMuted,
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
