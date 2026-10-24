import csharpGrammarUrl from "../../../../node_modules/tree-sitter-c-sharp/tree-sitter-c_sharp.wasm?url";
import cssGrammarUrl from "../../../../node_modules/tree-sitter-css/tree-sitter-css.wasm?url";
import goGrammarUrl from "../../../../node_modules/tree-sitter-go/tree-sitter-go.wasm?url";
import javaGrammarUrl from "../../../../node_modules/tree-sitter-java/tree-sitter-java.wasm?url";
import jsonGrammarUrl from "../../../../node_modules/tree-sitter-json/tree-sitter-json.wasm?url";
import pythonGrammarUrl from "../../../../node_modules/tree-sitter-python/tree-sitter-python.wasm?url";
import javascriptGrammarUrl from "../../../../node_modules/@willbooster/tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import rustGrammarUrl from "../../../../node_modules/@willbooster/tree-sitter-rust/tree-sitter-rust.wasm?url";
import tsxGrammarUrl from "../../../../node_modules/@willbooster/tree-sitter-typescript/tree-sitter-tsx.wasm?url";
import typescriptGrammarUrl from "../../../../node_modules/@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm?url";
import type { StructureRules } from "./structure-rules";

/** Where a language's tree-sitter grammar comes from: a bundled asset, or bytes a plugin provides. */
export type GrammarSource = { url: string } | { bytes: () => Promise<Uint8Array> };

/** How declarations are read: hand-written adapters, declarative rules, or a line reader without a grammar. */
export type StructureAdapter =
  | { type: "script" }
  | { type: "rust" }
  | { type: "rules"; rules: StructureRules }
  | { type: "markdown" };

export interface LanguageDefinition {
  id: string;
  name: string;
  /** Lower-case file extensions without the dot. */
  extensions: string[];
  /** Whole file names, lower-case, for files without a telling extension. */
  fileNames?: string[];
  /** The Monaco language used for highlighting. */
  monacoLanguage: string;
  /** Absent for languages whose structure is read without a parser. */
  grammar?: GrammarSource;
  structure: StructureAdapter;
  source: "builtin" | "plugin";
  /** Changes when the definition changes, so cached parse results are not reused across versions. */
  version: string;
}

const COMMENTS = ["comment"];

const PYTHON: StructureRules = {
  imports: ["import_statement", "import_from_statement", "future_import_statement"],
  leading: COMMENTS,
  wrappers: ["decorated_definition"],
  declarations: [
    { node: "class_definition", kind: "class", body: [{ field: "body" }], members: true },
    {
      node: "function_definition",
      kind: "function",
      kindInside: { class: "method" },
      parameters: [{ field: "parameters" }],
      returnType: [{ field: "return_type" }],
      body: [{ field: "body" }],
    },
    // `NAME = value` at module or class level; attribute and tuple targets are not names.
    {
      node: "expression_statement",
      kind: "variable",
      kindInside: { class: "property" },
      name: { path: [{ child: "assignment" }, { field: "left" }], pattern: "^([A-Za-z_][A-Za-z0-9_]*)$" },
    },
  ],
};

const GO: StructureRules = {
  imports: ["package_clause", "import_declaration"],
  leading: COMMENTS,
  wrappers: ["type_declaration", "const_declaration", "var_declaration"],
  declarations: [
    {
      node: "function_declaration",
      kind: "function",
      parameters: [{ field: "parameters" }],
      returnType: [{ field: "result" }],
      body: [{ field: "body" }],
    },
    {
      node: "method_declaration",
      kind: "method",
      // The receiver type, without a pointer or type parameters: `func (u *User[T]) Load` is `User.Load`.
      qualifier: { path: [{ field: "receiver" }], pattern: "([A-Za-z_][A-Za-z0-9_]*)(?:\\[[^\\]]*\\])?\\s*\\)$" },
      parameters: [{ field: "parameters" }],
      returnType: [{ field: "result" }],
      body: [{ field: "body" }],
    },
    {
      node: "type_spec",
      kind: "type",
      kindFrom: { path: [{ field: "type" }], map: { struct_type: "struct", interface_type: "interface" } },
      body: [{ field: "type" }],
      members: true,
    },
    { node: "type_alias", kind: "type" },
    { node: "method_elem", kind: "method", parameters: [{ field: "parameters" }], returnType: [{ field: "result" }] },
    { node: "const_spec", kind: "constant" },
    { node: "var_spec", kind: "variable" },
  ],
};

const JAVA: StructureRules = {
  imports: ["package_declaration", "import_declaration"],
  leading: ["line_comment", "block_comment"],
  // Methods and fields of an enum follow its constants inside this node.
  wrappers: ["enum_body_declarations"],
  declarations: [
    { node: "class_declaration", kind: "class", body: [{ field: "body" }], members: true },
    { node: "record_declaration", kind: "class", parameters: [{ field: "parameters" }], body: [{ field: "body" }], members: true },
    { node: "interface_declaration", kind: "interface", body: [{ field: "body" }], members: true },
    { node: "annotation_type_declaration", kind: "interface", body: [{ field: "body" }], members: true },
    { node: "enum_declaration", kind: "enum", body: [{ field: "body" }], members: true },
    {
      node: "method_declaration",
      kind: "method",
      parameters: [{ field: "parameters" }],
      returnType: [{ field: "type" }],
      body: [{ field: "body" }],
    },
    { node: "constructor_declaration", kind: "method", parameters: [{ field: "parameters" }], body: [{ field: "body" }] },
    { node: "field_declaration", kind: "property", name: { path: [{ field: "declarator" }, { field: "name" }] } },
    { node: "constant_declaration", kind: "constant", name: { path: [{ field: "declarator" }, { field: "name" }] } },
  ],
};

const CSHARP: StructureRules = {
  imports: ["using_directive", "extern_alias_directive"],
  leading: COMMENTS,
  declarations: [
    { node: "namespace_declaration", kind: "module", body: [{ field: "body" }], members: true },
    { node: "file_scoped_namespace_declaration", kind: "module" },
    { node: "class_declaration", kind: "class", body: [{ field: "body" }], members: true },
    { node: "record_declaration", kind: "class", body: [{ field: "body" }], members: true },
    { node: "struct_declaration", kind: "struct", body: [{ field: "body" }], members: true },
    { node: "interface_declaration", kind: "interface", body: [{ field: "body" }], members: true },
    { node: "enum_declaration", kind: "enum" },
    { node: "delegate_declaration", kind: "type", parameters: [{ field: "parameters" }], returnType: [{ field: "type" }] },
    {
      node: "method_declaration",
      kind: "method",
      parameters: [{ field: "parameters" }],
      returnType: [{ field: "returns" }],
      body: [{ field: "body" }],
    },
    { node: "constructor_declaration", kind: "method", parameters: [{ field: "parameters" }], body: [{ field: "body" }] },
    { node: "destructor_declaration", kind: "method", name: { path: [{ field: "name" }], prefix: "~" }, parameters: [{ field: "parameters" }], body: [{ field: "body" }] },
    { node: "operator_declaration", kind: "method", name: { path: [{ field: "operator" }], prefix: "operator " }, parameters: [{ field: "parameters" }], returnType: [{ field: "type" }], body: [{ field: "body" }] },
    { node: "property_declaration", kind: "property" },
    { node: "event_declaration", kind: "property" },
    { node: "field_declaration", kind: "property", name: { path: [{ child: "variable_declaration" }, { child: "variable_declarator" }, { field: "name" }] } },
  ],
};

const CSS: StructureRules = {
  imports: ["import_statement", "charset_statement", "namespace_statement"],
  leading: COMMENTS,
  declarations: [
    { node: "rule_set", kind: "rule", name: { path: [{ child: "selectors" }] }, body: [{ child: "block" }], members: true },
    { node: "media_statement", kind: "rule", name: { path: [], pattern: "^(@media[^{]*?)\\s*\\{" }, body: [{ child: "block" }], members: true },
    { node: "supports_statement", kind: "rule", name: { path: [], pattern: "^(@supports[^{]*?)\\s*\\{" }, body: [{ child: "block" }], members: true },
    { node: "keyframes_statement", kind: "rule", name: { path: [{ child: "keyframes_name" }], prefix: "@keyframes " } },
    { node: "at_rule", kind: "rule", name: { path: [], pattern: "^(@[\\w-]+[^{;]*?)\\s*[{;]" }, body: [{ child: "block" }], members: true },
  ],
};

const JSON_RULES: StructureRules = {
  transparent: ["object"],
  declarations: [
    { node: "pair", kind: "key", name: { path: [{ field: "key" }], unquote: true }, body: [{ field: "value" }], members: true },
  ],
};

const BUILTIN = "builtin-1";

export const BUILTIN_LANGUAGES: readonly LanguageDefinition[] = [
  { id: "javascript", name: "JavaScript", extensions: ["js", "mjs", "cjs"], monacoLanguage: "javascript", grammar: { url: javascriptGrammarUrl }, structure: { type: "script" }, source: "builtin", version: BUILTIN },
  { id: "jsx", name: "JSX", extensions: ["jsx"], monacoLanguage: "javascript", grammar: { url: tsxGrammarUrl }, structure: { type: "script" }, source: "builtin", version: BUILTIN },
  { id: "typescript", name: "TypeScript", extensions: ["ts", "mts", "cts"], monacoLanguage: "typescript", grammar: { url: typescriptGrammarUrl }, structure: { type: "script" }, source: "builtin", version: BUILTIN },
  { id: "tsx", name: "TSX", extensions: ["tsx"], monacoLanguage: "typescript", grammar: { url: tsxGrammarUrl }, structure: { type: "script" }, source: "builtin", version: BUILTIN },
  { id: "rust", name: "Rust", extensions: ["rs"], monacoLanguage: "rust", grammar: { url: rustGrammarUrl }, structure: { type: "rust" }, source: "builtin", version: BUILTIN },
  { id: "python", name: "Python", extensions: ["py", "pyi", "pyw"], monacoLanguage: "python", grammar: { url: pythonGrammarUrl }, structure: { type: "rules", rules: PYTHON }, source: "builtin", version: BUILTIN },
  { id: "go", name: "Go", extensions: ["go"], monacoLanguage: "go", grammar: { url: goGrammarUrl }, structure: { type: "rules", rules: GO }, source: "builtin", version: BUILTIN },
  { id: "java", name: "Java", extensions: ["java"], monacoLanguage: "java", grammar: { url: javaGrammarUrl }, structure: { type: "rules", rules: JAVA }, source: "builtin", version: BUILTIN },
  { id: "csharp", name: "C#", extensions: ["cs", "csx"], monacoLanguage: "csharp", grammar: { url: csharpGrammarUrl }, structure: { type: "rules", rules: CSHARP }, source: "builtin", version: BUILTIN },
  { id: "css", name: "CSS", extensions: ["css"], monacoLanguage: "css", grammar: { url: cssGrammarUrl }, structure: { type: "rules", rules: CSS }, source: "builtin", version: BUILTIN },
  { id: "json", name: "JSON", extensions: ["json", "jsonc", "json5", "webmanifest"], fileNames: [".babelrc", ".eslintrc", ".prettierrc"], monacoLanguage: "json", grammar: { url: jsonGrammarUrl }, structure: { type: "rules", rules: JSON_RULES }, source: "builtin", version: BUILTIN },
  { id: "markdown", name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"], monacoLanguage: "markdown", structure: { type: "markdown" }, source: "builtin", version: BUILTIN },
];

/** Exposed for tests and tooling that read the rules without a registry. */
export const BUILTIN_RULES = { python: PYTHON, go: GO, java: JAVA, csharp: CSHARP, css: CSS, json: JSON_RULES } as const;
