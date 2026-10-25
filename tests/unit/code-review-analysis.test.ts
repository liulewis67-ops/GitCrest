import { Parser, type Language } from "@willbooster/web-tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeCodeReview, OTHER_STRUCTURE_ID, structureSelection, type CodeReviewAnalysis } from "../../src/features/diff/model/code-review-analysis";
import { extractDeclarations, type StructureGrammar } from "../../src/features/languages/model/code-structure";
import { diffDocuments as documents, loadTestGrammar, selectedRowTexts as selectedNewTexts, structureOf as structure } from "../fixtures/code-review";

const languages = new Map<StructureGrammar, Language>();

beforeAll(async () => {
  const grammarFiles: Record<StructureGrammar, string> = {
    javascript: "node_modules/@willbooster/tree-sitter-javascript/tree-sitter-javascript.wasm",
    typescript: "node_modules/@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm",
    tsx: "node_modules/@willbooster/tree-sitter-typescript/tree-sitter-tsx.wasm",
    rust: "node_modules/@willbooster/tree-sitter-rust/tree-sitter-rust.wasm",
  };
  for (const [grammar, file] of Object.entries(grammarFiles) as Array<[StructureGrammar, string]>) {
    languages.set(grammar, await loadTestGrammar(file));
  }
});

function declarations(grammar: StructureGrammar, source: string) {
  const parser = new Parser();
  parser.setLanguage(languages.get(grammar)!);
  const tree = parser.parse(source)!;
  try {
    return { declarations: extractDeclarations(tree.rootNode, grammar), hasError: tree.rootNode.hasError };
  } finally {
    tree.delete();
    parser.delete();
  }
}

function analyze(grammar: StructureGrammar, before: string, after: string, path = "src/file.ts"): CodeReviewAnalysis {
  const { full, hunks } = documents(path, before, after);
  const old = declarations(grammar, before);
  const modified = declarations(grammar, after);
  const result = analyzeCodeReview({ fullDocument: full, hunksDocument: hunks, oldDeclarations: old.declarations, newDeclarations: modified.declarations, recovered: old.hasError || modified.hasError });
  if (result.status !== "ready") throw new Error("analysis is stale");
  return result.analysis;
}

const filler = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `  const ${prefix}${index} = ${index};`).join("\n");

describe("code-aware diff analysis", () => {
  it("collects one function's changes from several hunks and selects only its rows", () => {
    const before = `export function loadUser(id: string) {\n  const a = 1;\n${filler(8, "x")}\n  const b = 2;\n${filler(8, "y")}\n  return a + b;\n}\n\nexport function other() {\n  return 1;\n}\n`;
    const after = before.replace("const a = 1;", "const a = 10;").replace("const b = 2;", "const b = 20;").replace("return a + b;", "return a * b;");
    const { hunks } = documents("src/file.ts", before, after);
    const analysis = analyze("typescript", before, after);

    expect(hunks.hunks.length).toBeGreaterThan(1);
    expect(analysis.structures.map((item) => item.id)).toEqual(["function:loadUser"]);
    const loadUser = structure(analysis, "function:loadUser");
    expect(loadUser.atoms).toHaveLength(3);
    expect(loadUser.facts.map((fact) => fact.kind)).toEqual(["body"]);
    expect(selectedNewTexts(analysis, hunks, "function:loadUser")).toEqual([
      "  const a = 1; →   const a = 10;",
      "  const b = 2; →   const b = 20;",
      "  return a + b; →   return a * b;",
    ]);
  });

  it("separates adjacent functions changed in the same hunk", () => {
    const before = "function first() {\n  return 1;\n}\nfunction second() {\n  return 2;\n}\n";
    const after = "function first() {\n  return 11;\n}\nfunction second() {\n  return 22;\n}\n";
    const { hunks } = documents("src/file.js", before, after);
    const analysis = analyze("javascript", before, after, "src/file.js");

    expect(hunks.hunks).toHaveLength(1);
    expect(selectedNewTexts(analysis, hunks, "function:first")).toEqual(["  return 1; →   return 11;"]);
    expect(selectedNewTexts(analysis, hunks, "function:second")).toEqual(["  return 2; →   return 22;"]);
  });

  it("takes only a structure's own side of a row shared with another structure", () => {
    // Two declarations on one line and a replaced line are one row of the diff each.
    const before = "export const TIMEOUT = 1, RETRIES = 2;\n";
    const after = "export const TIMEOUT = 5, RETRIES = 3;\n";
    const analysis = analyze("typescript", before, after);
    expect(analysis.structures.map((item) => item.id)).toEqual(["constant:TIMEOUT, RETRIES"]);

    const replaced = analyze("typescript", "function a() {}\n", "function b() {}\n");
    const added = structure(replaced, "function:b");
    expect(added.status).toBe("added");
    expect(added.sharedAtoms).toHaveLength(1);
    expect(structure(replaced, "function:a").status).toBe("removed");
    // Replacing a by b pairs a's deleted line with b's added line; each structure takes its own half.
    expect(structureSelection(replaced, "function:b", false)).toMatchObject({ rows: [{ hunkIndex: 0, rowIndex: 0, side: "new" }], withheld: 0, halves: 1 });
    expect(structureSelection(replaced, "function:a", false)).toMatchObject({ rows: [{ hunkIndex: 0, rowIndex: 0, side: "old" }], halves: 1 });

    // Two declarations on one line share both sides, so neither can take the row alone.
    const sameLine = analyze("javascript", "function a() {} function b() {}\n", "function a() { 1 } function b() {}\n", "src/file.js");
    expect(structureSelection(sameLine, "function:a", false)).toMatchObject({ rows: [], withheld: 1 });
  });

  it("keeps a class's own declaration change apart from its methods", () => {
    const before = "class UserClient {\n  private cache = new Map();\n\n  loadUser(id) {\n    return this.cache.get(id);\n  }\n}\n";
    const after = "export class UserClient extends Base {\n  private cache = new Map();\n\n  async loadUser(id: string, force = false): Promise<User> {\n    if (force) this.cache.delete(id);\n    return this.cache.get(id);\n  }\n}\n";
    const { hunks } = documents("src/file.ts", before, after);
    const analysis = analyze("typescript", before, after);

    const client = structure(analysis, "class:UserClient");
    const loadUser = structure(analysis, "class:UserClient/method:loadUser");
    expect(client.atoms).toHaveLength(1);
    expect(client.facts.map((fact) => fact.kind)).toEqual(["declaration", "members"]);
    expect(loadUser.depth).toBe(1);
    expect(loadUser.facts.map((fact) => fact.kind)).toEqual(expect.arrayContaining(["parameters", "returnType", "body"]));
    expect(selectedNewTexts(analysis, hunks, "class:UserClient")).toEqual(["class UserClient { → export class UserClient extends Base {"]);
    const all = structureSelection(analysis, "class:UserClient", true).rows;
    expect(all).toHaveLength(client.atoms.length + loadUser.atoms.length);
    expect(client.memberAtoms).toEqual(loadUser.atoms);
  });

  it("attaches a new function's blank separator and doc comment to it", () => {
    const before = "function keep() {\n  return 1;\n}\n";
    const after = "function keep() {\n  return 1;\n}\n\n/** Clears the cache. */\nfunction clearCache() {\n  cache.clear();\n}\n";
    const analysis = analyze("javascript", before, after, "src/file.js");

    const added = structure(analysis, "function:clearCache");
    expect(added.status).toBe("added");
    expect(added.atoms).toHaveLength(analysis.atoms.length);
    expect(analysis.structures.some((item) => item.id === OTHER_STRUCTURE_ID)).toBe(false);
  });

  it("groups imports and leaves top-level statements unattributed", () => {
    const before = "import { a } from \"a\";\n\nconsole.log(a);\n";
    const after = "import { a } from \"a\";\nimport { b } from \"b\";\n\nconsole.log(a, b);\n";
    const analysis = analyze("typescript", before, after);
    expect(structure(analysis, "imports:").atoms).toHaveLength(1);
    expect(structure(analysis, OTHER_STRUCTURE_ID).atoms).toHaveLength(1);
  });

  it("describes Rust signatures and nests methods under their impl", () => {
    const before = "use std::io;\n\nimpl Client {\n    pub fn load(&self, id: u32) -> Option<User> {\n        self.cache.get(&id)\n    }\n}\n";
    const after = "use std::io;\n\nimpl Client {\n    pub fn load(&self, id: u64) -> Result<User, Error> {\n        self.cache.get(&id)\n    }\n}\n";
    const analysis = analyze("rust", before, after, "src/lib.rs");
    const load = structure(analysis, "impl:Client/method:load");
    expect(load.facts.map((fact) => fact.kind)).toEqual(["parameters", "returnType"]);
    expect(structure(analysis, "impl:Client").atoms).toHaveLength(0);

    const oneLine = analyze("javascript", "const f = (a) => { return a; };\n", "const f = (a) => { return a + 1; };\n", "src/file.js");
    expect(structure(oneLine, "function:f").facts.map((fact) => fact.kind)).toEqual(["body"]);
  });

  it("reports the documents as stale when the full file and hunks disagree", () => {
    const before = "function a() {\n  return 1;\n}\n";
    const after = "function a() {\n  return 2;\n}\n";
    const { full, hunks } = documents("src/file.js", before, after);
    const changed = documents("src/file.js", before, after.replace("return 2", "return 3")).hunks;
    const parsed = declarations("javascript", after).declarations;
    const input = { fullDocument: full, oldDeclarations: declarations("javascript", before).declarations, newDeclarations: parsed, recovered: false };
    expect(analyzeCodeReview({ ...input, hunksDocument: hunks }).status).toBe("ready");
    expect(analyzeCodeReview({ ...input, hunksDocument: changed }).status).toBe("stale");
  });

  it("lists changes under a syntax error without describing them", () => {
    const before = "function broken() {\n  return 1;\n}\n";
    const after = "function broken() {\n  return (1;\n}\n";
    const analysis = analyze("javascript", before, after, "src/file.js");
    expect(analysis.partial).toBe(true);
    const broken = structure(analysis, "function:broken");
    expect(broken.reliable).toBe(false);
    expect(broken.facts).toEqual([]);
  });
});
