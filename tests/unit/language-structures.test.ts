import { describe, expect, it } from "vitest";
import { BUILTIN_RULES } from "../../src/features/languages/model/builtin-languages";
import { extractMarkdownSections } from "../../src/features/languages/model/markdown-structure";
import { extractWithRules, type StructureRules } from "../../src/features/languages/model/structure-rules";
import { analyzeSources, factsOf, parseWith, selectedRowTexts, structureOf } from "../fixtures/code-review";

const GRAMMARS = {
  python: "node_modules/tree-sitter-python/tree-sitter-python.wasm",
  go: "node_modules/tree-sitter-go/tree-sitter-go.wasm",
  java: "node_modules/tree-sitter-java/tree-sitter-java.wasm",
  csharp: "node_modules/tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  css: "node_modules/tree-sitter-css/tree-sitter-css.wasm",
  json: "node_modules/tree-sitter-json/tree-sitter-json.wasm",
} as const;

function reader(language: keyof typeof GRAMMARS, rules: StructureRules = BUILTIN_RULES[language]) {
  return (source: string) => parseWith(GRAMMARS[language], source, (root) => extractWithRules(root, rules));
}

async function keys(language: keyof typeof GRAMMARS, source: string): Promise<string[]> {
  return (await reader(language)(source)).declarations.map((declaration) => declaration.key);
}

describe("built-in language structure", () => {
  it("reads Python classes, decorated methods, functions, assignments and imports", async () => {
    const source = "import os\nfrom a import b\n\n@dataclass\nclass User(Base):\n    name: str = \"\"\n\n    @property\n    def full(self):\n        return self.name\n\n    def load(self, id: int) -> \"User\":\n        return id\n\nasync def fetch(url):\n    pass\n\nTIMEOUT = 5\nobj.attr = 1\n";
    expect(await keys("python", source)).toEqual(["imports:", "class:User", "class:User/property:name", "class:User/method:full", "class:User/method:load", "function:fetch", "variable:TIMEOUT"]);

    const after = source.replace("def load(self, id: int) -> \"User\":\n        return id", "def load(self, id: int, force=False) -> \"User | None\":\n        return None").replace("@property\n", "@cached_property\n");
    const { analysis, hunks } = await analyzeSources("app.py", source, after, reader("python"));
    expect(factsOf(analysis, "class:User/method:load")).toEqual(["parameters", "returnType", "body"]);
    // The decorator belongs to the method it decorates.
    expect(selectedRowTexts(analysis, hunks, "class:User/method:full")).toEqual(["    @property →     @cached_property"]);
  });

  it("reads Go functions, methods by receiver type, structs, interfaces and grouped declarations", async () => {
    const source = "package main\n\nimport (\n\t\"fmt\"\n)\n\ntype User struct {\n\tName string\n}\n\ntype Loader interface {\n\tLoad(id int) error\n}\n\n// Load loads.\nfunc (u *User) Load(id int) (string, error) {\n\treturn \"\", nil\n}\n\nfunc main() {}\n\nconst (\n\tA = 1\n\tB = 2\n)\nvar x = 1\n";
    expect(await keys("go", source)).toEqual(["imports:", "struct:User", "interface:Loader", "interface:Loader/method:Load", "method:User.Load", "function:main", "constant:A", "constant:B", "variable:x"]);

    const after = source.replace("func (u *User) Load(id int) (string, error) {\n\treturn \"\", nil", "func (u *User) Load(id int64) (string, error) {\n\treturn fmt.Sprint(id), nil").replace("\tB = 2", "\tB = 3");
    const { analysis, hunks } = await analyzeSources("main.go", source, after, reader("go"));
    expect(factsOf(analysis, "method:User.Load")).toEqual(["parameters", "body"]);
    // Each constant of a group is its own structure.
    expect(selectedRowTexts(analysis, hunks, "constant:B")).toEqual(["\tB = 2 → \tB = 3"]);
    expect(analysis.structures.some((structure) => structure.id === "constant:A")).toBe(false);
  });

  it("reads Java types, members and enum methods", async () => {
    const source = "package a;\nimport java.util.List;\n\n/** Doc */\n@Service\npublic class User {\n  private String name;\n  public User(String n) { name = n; }\n  public String load(int id) {\n    return name;\n  }\n  enum Kind { A; void m() {} }\n  interface Inner { void m(); }\n  record R(int x) {}\n}\n";
    expect(await keys("java", source)).toEqual(["imports:", "class:User", "class:User/property:name", "class:User/method:User", "class:User/method:load", "class:User/enum:Kind", "class:User/enum:Kind/method:m", "class:User/interface:Inner", "class:User/interface:Inner/method:m", "class:User/class:R"]);

    const after = source.replace("public String load(int id) {\n    return name;", "public String load(long id) {\n    return name.trim();");
    const { analysis } = await analyzeSources("User.java", source, after, reader("java"));
    expect(factsOf(analysis, "class:User/method:load")).toEqual(["parameters", "body"]);
    expect(structureOf(analysis, "class:User").memberAtoms).toHaveLength(2);
  });

  it("reads C# namespaces, types and members", async () => {
    const source = "using System;\nnamespace App.Core {\n  /// Doc\n  public class User : Base {\n    private string name;\n    public string Name { get; set; }\n    public User(string n) { name = n; }\n    public async Task<string> Load(int id) {\n      return name;\n    }\n  }\n  public interface ILoader { void Load(); }\n  public enum Kind { A }\n  public struct P { }\n}\n";
    expect(await keys("csharp", source)).toEqual([
      "imports:",
      "module:App.Core",
      "module:App.Core/class:User",
      "module:App.Core/class:User/property:name",
      "module:App.Core/class:User/property:Name",
      "module:App.Core/class:User/method:User",
      "module:App.Core/class:User/method:Load",
      "module:App.Core/interface:ILoader",
      "module:App.Core/interface:ILoader/method:Load",
      "module:App.Core/enum:Kind",
      "module:App.Core/struct:P",
    ]);

    const after = source.replace("public async Task<string> Load(int id) {\n      return name;", "public async Task<string?> Load(int id) {\n      return name;");
    const { analysis } = await analyzeSources("User.cs", source, after, reader("csharp"));
    expect(factsOf(analysis, "module:App.Core/class:User/method:Load")).toEqual(["returnType"]);
  });

  it("reads CSS rules, nested media rules and at-rules", async () => {
    const source = "@import url(\"a.css\");\n.button,\n.link:hover {\n  color: red;\n}\n@media (max-width: 600px) {\n  .button { color: blue; }\n}\n@keyframes spin { from { opacity: 0 } }\n:root { --a: 1; }\n";
    expect(await keys("css", source)).toEqual(["imports:", "rule:.button, .link:hover", "rule:@media (max-width: 600px)", "rule:@media (max-width: 600px)/rule:.button", "rule:@keyframes spin", "rule::root"]);

    const after = source.replace("  .button { color: blue; }", "  .button { color: green; }");
    const { analysis } = await analyzeSources("app.css", source, after, reader("css"));
    expect(analysis.structures.map((structure) => structure.id)).toEqual(["rule:@media (max-width: 600px)", "rule:@media (max-width: 600px)/rule:.button"]);
    expect(factsOf(analysis, "rule:@media (max-width: 600px)/rule:.button")).toEqual(["declaration"]);
  });

  it("reads JSON keys as nested structures and reports value changes", async () => {
    const source = "{\n  \"name\": \"app\",\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"test\": \"vitest\"\n  },\n  \"list\": [1, 2]\n}\n";
    expect(await keys("json", source)).toEqual(["key:name", "key:scripts", "key:scripts/key:dev", "key:scripts/key:test", "key:list"]);

    const after = source.replace("\"test\": \"vitest\"", "\"test\": \"vitest run\"");
    const { analysis } = await analyzeSources("package.json", source, after, reader("json"));
    expect(factsOf(analysis, "key:scripts/key:test")).toEqual(["value"]);
    expect(factsOf(analysis, "key:scripts")).toEqual(["members"]);
  });

  it("reads Markdown sections without a grammar, skipping code fences and front matter", async () => {
    const source = "---\ntitle: x\n---\n# Title\n\nIntro.\n\n## Install\n\nRun it.\n\n```sh\n# not a heading\n```\n\n### Windows\n\nText\n\nSetext\n======\n\nAfter.\n";
    const sections = extractMarkdownSections(source);
    expect(sections.map((section) => [section.key, section.range.start, section.range.end])).toEqual([
      ["section:Title", 4, 19],
      ["section:Title/section:Install", 8, 19],
      ["section:Title/section:Install/section:Windows", 16, 19],
      ["section:Setext", 20, 23],
    ]);

    const after = source.replace("Run it.", "Run it twice.");
    const { analysis } = await analyzeSources("README.md", source, after, async (text) => ({ declarations: extractMarkdownSections(text), hasError: false }));
    expect(factsOf(analysis, "section:Title/section:Install")).toEqual(["content"]);
    expect(factsOf(analysis, "section:Title")).toEqual(["members"]);
  });
});
