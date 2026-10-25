import { describe, expect, it } from "vitest";
import { stripComments, tokens } from "../../src/features/diff/model/code-text";
import { rowKey } from "../../src/features/diff/model/code-review-analysis";
import { selectedRowCount, selectedRowKeys, selectionFromKeys, withoutRows, withRows, withRowState } from "../../src/features/diff/model/row-selection";
import { dependencyHints, selectedDebugRows } from "../../src/features/diff/model/selection-hints";
import { BUILTIN_LANGUAGES, BUILTIN_RULES } from "../../src/features/languages/model/builtin-languages";
import { extractDeclarations } from "../../src/features/languages/model/code-structure";
import { extractWithRules, validateLanguageSyntax } from "../../src/features/languages/model/structure-rules";
import { analyzeSources, diffDocuments, factsOf, parseWith, structureOf } from "../fixtures/code-review";

const TS = "node_modules/@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm";
const JAVA = "node_modules/tree-sitter-java/tree-sitter-java.wasm";
const PYTHON = "node_modules/tree-sitter-python/tree-sitter-python.wasm";
const syntaxOf = (id: string) => BUILTIN_LANGUAGES.find((language) => language.id === id)?.syntax;

const readTs = (source: string) => parseWith(TS, source, (root) => extractDeclarations(root, "typescript"));
const readJava = (source: string) => parseWith(JAVA, source, (root) => extractWithRules(root, BUILTIN_RULES.java));
const readPython = (source: string) => parseWith(PYTHON, source, (root) => extractWithRules(root, BUILTIN_RULES.python));

describe("overloads", () => {
  const before = "class Repo {\n  User load(int id) {\n    return find(id);\n  }\n\n  User load(String name) {\n    return byName(name);\n  }\n}\n";

  it("tells overloads apart by their parameter lists", async () => {
    const after = before.replace("return byName(name);", "return byName(name.trim());");
    const { analysis } = await analyzeSources("Repo.java", before, after, readJava, syntaxOf("java"));
    const changed = structureOf(analysis, "class:Repo/method:load(String name)");
    expect(changed.detail).toBe("(String name)");
    expect(factsOf(analysis, "class:Repo/method:load(String name)")).toEqual(["body"]);
    expect(analysis.structures.some((structure) => structure.id === "class:Repo/method:load(int id)")).toBe(false);
  });

  it("keeps a method matched when an overload is added beside it", async () => {
    const single = "class Repo {\n  User load(int id) {\n    return find(id);\n  }\n}\n";
    const after = single.replace("    return find(id);\n  }\n", "    return find(id);\n  }\n\n  User load(String name) {\n    return byName(name);\n  }\n");
    const { analysis } = await analyzeSources("Repo.java", single, after, readJava, syntaxOf("java"));
    expect(structureOf(analysis, "class:Repo/method:load(String name)").status).toBe("added");
    expect(analysis.structures.some((structure) => structure.id.startsWith("class:Repo/method:load(int id)"))).toBe(false);
  });
});

describe("finer change descriptions", () => {
  it("names modifier, annotation and comment changes", async () => {
    const before = "export class Api {\n  /** Loads. */\n  load(id: string) {\n    return id;\n  }\n\n  save() {\n    return 1;\n  }\n}\n";
    const after = before.replace("  load(id: string) {", "  async load(id: string) {").replace("/** Loads. */", "/** Loads a user. */");
    const { analysis } = await analyzeSources("api.ts", before, after, readTs, syntaxOf("typescript"));
    expect(factsOf(analysis, "class:Api/method:load")).toEqual(["modifiers", "comments"]);

    const onlyAsync = before.replace("  load(id: string) {", "  async load(id: string) {");
    expect(factsOf((await analyzeSources("api.ts", before, onlyAsync, readTs, syntaxOf("typescript"))).analysis, "class:Api/method:load")).toEqual(["modifiers"]);

    const onlyComment = before.replace("/** Loads. */", "/** Loads a user. */");
    const commented = (await analyzeSources("api.ts", before, onlyComment, readTs, syntaxOf("typescript"))).analysis;
    expect(factsOf(commented, "class:Api/method:load")).toEqual(["comments"]);
    expect(structureOf(commented, "class:Api/method:load").noise).toBe("comments");

    const java = "class A {\n  void run() {\n    go();\n  }\n}\n";
    const annotated = java.replace("  void run() {", "  @Override\n  void run() {");
    expect(factsOf((await analyzeSources("A.java", java, annotated, readJava, syntaxOf("java"))).analysis, "class:A/method:run")).toEqual(["annotations"]);
  });

  it("marks reformatting as formatting only, but not changes inside strings", async () => {
    const before = "function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n";
    const reflowed = "function total(items) {\n  return items.reduce(\n    (sum, item) => sum + item.price,\n    0,\n  );\n}\n";
    const notTrailing = reflowed.replace("    0,\n", "    0\n");
    const { analysis } = await analyzeSources("total.ts", before, notTrailing, readTs, syntaxOf("typescript"));
    expect(structureOf(analysis, "function:total").noise).toBe("formatting");
    expect(factsOf(analysis, "function:total")).toEqual(["formatting"]);

    const quoted = "function label() {\n  return \"a b\";\n}\n";
    const spaced = quoted.replace("\"a b\"", "\"a  b\"");
    const strings = (await analyzeSources("label.ts", quoted, spaced, readTs, syntaxOf("typescript"))).analysis;
    expect(structureOf(strings, "function:label").noise).toBeUndefined();
  });
});

describe("selection hints", () => {
  it("flags added debug output and offers to deselect it", async () => {
    const before = "function load(id: string) {\n  return fetch(id);\n}\n";
    const after = "function load(id: string) {\n  console.log(\"load\", id);\n  return fetch(id);\n}\n";
    const { analysis, hunks } = await analyzeSources("load.ts", before, after, readTs, syntaxOf("typescript"));
    expect(factsOf(analysis, "function:load")).toEqual(["body", "debug"]);
    const all = selectedRowKeys(hunks, [{ hunkIndex: 0 }]);
    const debug = selectedDebugRows(analysis, all);
    expect(debug).toHaveLength(1);
    expect(selectedDebugRows(analysis, withoutRows(all, debug))).toEqual([]);
  });

  it("points out a new name the selection uses but leaves undefined", async () => {
    const before = "import os\n\n\ndef helper(x):\n    return x\n";
    const after = "import os\nimport sys\n\n\ndef helper(x):\n    sys.stdout.write(x)\n    return x\n";
    const { analysis } = await analyzeSources("app.py", before, after, readPython, syntaxOf("python"));
    const useRow = analysis.atoms.find((atom) => atom.newText?.includes("sys.stdout"))!.selection!;
    const importRow = analysis.atoms.find((atom) => atom.newText === "import sys")!.selection!;

    const onlyUse = withRows(new Set(), [useRow]);
    expect(dependencyHints(analysis, onlyUse)).toEqual([{ name: "sys", rows: [importRow] }]);
    expect(dependencyHints(analysis, withRows(onlyUse, [importRow]))).toEqual([]);
  });

  it("does not hint at names the old file already had", async () => {
    const before = "import os\n\n\ndef helper(x):\n    return x\n";
    const after = before.replace("    return x", "    os.sep\n    return x");
    const { analysis, hunks } = await analyzeSources("app.py", before, after, readPython, syntaxOf("python"));
    expect(dependencyHints(analysis, selectedRowKeys(hunks, [{ hunkIndex: 0 }]))).toEqual([]);
  });
});

describe("row selection keys", () => {
  const { hunks } = diffDocuments("a.ts", "a\nb\nc\n", "a\nB\nC\n");

  it("merges halves into whole rows and compacts whole hunks", () => {
    let keys = withRowState(new Set(), 0, 1, "old");
    expect([...keys]).toEqual([`${rowKey(0, 1)}:old`]);
    keys = withRowState(keys, 0, 1, "all");
    keys = withRows(keys, [{ hunkIndex: 0, rowIndex: 2, side: "new" }, { hunkIndex: 0, rowIndex: 2, side: "old" }]);
    expect(selectionFromKeys(hunks, keys)).toEqual([{ hunkIndex: 0 }]);
    expect(selectedRowCount(keys)).toBe(2);

    const half = withoutRows(keys, [{ hunkIndex: 0, rowIndex: 2, side: "new" }]);
    expect(selectionFromKeys(hunks, half)).toEqual([{ hunkIndex: 0, rowIndex: 1 }, { hunkIndex: 0, rowIndex: 2, side: "old" }]);
    expect(selectedRowKeys(hunks, selectionFromKeys(hunks, half))).toEqual(half);
  });
});

describe("plain-text helpers", () => {
  it("strips comments but keeps comment markers inside strings", () => {
    const syntax = { lineComments: ["//"], blockComments: [["/*", "*/"]] as Array<[string, string]> };
    expect(stripComments("const url = \"http://x\"; // note", syntax)).toBe("const url = \"http://x\"; ");
    expect(stripComments("a /* one\ntwo */ b", syntax)).toBe(`a ${" ".repeat(6)}\n${" ".repeat(6)} b`);
    expect(tokens("call( \"a  b\" , 1 )")).toEqual(["call", "(", "\"a  b\"", ",", "1", ")"]);
  });

  it("validates a plugin's syntax block", () => {
    expect(validateLanguageSyntax({ lineComments: ["--"], debugPatterns: ["\\bprint\\("] }).ok).toBe(true);
    const failure = (value: unknown) => {
      const result = validateLanguageSyntax(value);
      return result.ok ? "" : result.error;
    };
    expect(failure({ lineComments: ["a b"] })).toContain("syntax.lineComments[0]");
    expect(failure({ blockComments: [["/*"]] })).toContain("[open, close]");
    expect(failure({ debugPatterns: ["("] })).toContain("not a valid regular expression");
    expect(failure({ run: true })).toContain('unknown property "run"');
  });
});
