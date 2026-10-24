// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLanguagePlugins, parseLanguagePluginManifest, readLanguagePluginGrammar } from "../../electron/main/language-plugins";
import { BUILTIN_RULES } from "../../src/features/languages/model/builtin-languages";
import { definePlugins, languageForPath, setLanguagePluginsForTesting } from "../../src/features/languages/model/language-registry";
import { extractWithRules, validateStructureRules } from "../../src/features/languages/model/structure-rules";
import { analyzeSources, factsOf, parseWith } from "../fixtures/code-review";

const PYTHON_GRAMMAR = "node_modules/tree-sitter-python/tree-sitter-python.wasm";

// Starlark (Bazel build files) is Python-shaped, so the Python grammar stands in for a plugin's own.
const starlarkStructure = {
  imports: ["import_statement"],
  leading: ["comment"],
  declarations: [
    {
      node: "function_definition",
      kind: "function",
      parameters: [{ field: "parameters" }],
      body: [{ field: "body" }],
    },
    // A call to a build rule with a `name = "…"` argument, such as `cc_library(name = "core", …)`.
    {
      node: "expression_statement",
      kind: "rule",
      name: { path: [{ child: "call" }], pattern: "\\bname\\s*=\\s*\"([^\"]+)\"" },
    },
  ],
};

function manifest(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: "starlark", name: "Starlark", version: "1.0.0", extensions: ["bzl", ".Star"], fileNames: ["BUILD.bazel"], grammar: "tree-sitter-starlark.wasm", monacoLanguage: "python", structure: starlarkStructure, ...overrides };
}

describe("structure rule validation", () => {
  it("accepts every built-in rule set, so plugins can copy them as a starting point", () => {
    for (const rules of Object.values(BUILTIN_RULES)) expect(validateStructureRules(JSON.parse(JSON.stringify(rules))).ok).toBe(true);
  });

  it("names the problem in rules from outside GitCrest", () => {
    const failure = (structure: unknown) => {
      const result = validateStructureRules(structure);
      return result.ok ? "" : result.error;
    };
    expect(failure({ declarations: [] })).toContain("structure.declarations");
    expect(failure({ declarations: [{ node: "x", kind: "widget" }] })).toContain("structure.declarations[0].kind");
    expect(failure({ declarations: [{ node: "x", kind: "class", run: "alert(1)" }] })).toContain('unknown property "run"');
    expect(failure({ declarations: [{ node: "x", kind: "class", name: { pattern: "(" } }] })).toContain("not a valid regular expression");
    expect(failure({ declarations: [{ node: "x", kind: "class", members: true }] })).toContain("members needs a body path");
    expect(failure({ declarations: [{ node: "x", kind: "class" }, { node: "x", kind: "function" }] })).toContain("already has a rule");
    expect(failure({ declarations: [{ node: "x y", kind: "class" }] })).toContain("node");
    expect(failure({ declarations: [{ node: "x", kind: "class", body: [{ field: "a", child: "b" }] }] })).toContain("exactly one of field or child");
  });
});

describe("language plugin folders", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function plugin(folder: string, content: unknown, grammar: Uint8Array | null = new Uint8Array([0, 97, 115, 109])) {
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, "gitcrest-language.json"), typeof content === "string" ? content : JSON.stringify(content));
    const file = typeof content === "object" && content && "grammar" in content ? String((content as { grammar: unknown }).grammar) : "";
    if (grammar && file) await writeFile(join(root, folder, file), grammar);
  }

  it("checks manifests, reports broken plugins by folder and keeps the first of two ids", async () => {
    root = await mkdtemp(join(tmpdir(), "gitcrest-language-plugins-"));
    await plugin("a-starlark", manifest());
    await plugin("b-copy", manifest({ name: "Copy" }));
    await plugin("c-bad-json", "{ not json");
    await plugin("d-no-grammar", manifest({ id: "nogrammar" }), null);
    await plugin("e-escape", manifest({ id: "escape", grammar: "../a-starlark/tree-sitter-starlark.wasm" }));
    await mkdir(join(root, "f-empty"));

    const { plugins } = await listLanguagePlugins(root);
    const byFolder = Object.fromEntries(plugins.map((entry) => [entry.folder, entry]));
    expect(byFolder["a-starlark"]?.manifest).toMatchObject({ id: "starlark", extensions: ["bzl", "star"], fileNames: ["build.bazel"] });
    expect(byFolder["b-copy"]?.error).toContain('already uses the id "starlark"');
    expect(byFolder["c-bad-json"]?.error).toContain("not valid JSON");
    expect(byFolder["d-no-grammar"]?.error).toContain("is missing");
    expect(byFolder["e-escape"]?.error).toContain(".wasm file in the plugin folder");
    expect(byFolder["f-empty"]?.error).toContain("gitcrest-language.json is missing");

    expect(Array.from(await readLanguagePluginGrammar(root, "starlark"))).toEqual([0, 97, 115, 109]);
    await expect(readLanguagePluginGrammar(root, "../x")).rejects.toThrow("Invalid language plugin id");
    await expect(readLanguagePluginGrammar(root, "nogrammar")).rejects.toThrow("not available");
  });

  it("treats a missing plugin folder as no plugins", async () => {
    expect((await listLanguagePlugins(join(tmpdir(), "gitcrest-no-such-plugin-folder"))).plugins).toEqual([]);
  });

  it("accepts the documented example plugin", async () => {
    const example = JSON.parse(await readFile("doc/examples/language-plugin-starlark/gitcrest-language.json", "utf8"));
    const parsed = parseLanguagePluginManifest(example);
    expect(parsed.fileNames).toEqual(["build", "build.bazel", "workspace"]);
    expect(validateStructureRules(parsed.structure).ok).toBe(true);
  });

  it("rejects manifests outside the format", () => {
    expect(() => parseLanguagePluginManifest(manifest({ schemaVersion: 2 }))).toThrow("schemaVersion");
    expect(() => parseLanguagePluginManifest(manifest({ id: "Bad Id" }))).toThrow('"id"');
    expect(() => parseLanguagePluginManifest(manifest({ extensions: [], fileNames: [] }))).toThrow("at least one entry");
    expect(() => parseLanguagePluginManifest(manifest({ extensions: ["a/b"] }))).toThrow("extensions");
    expect(() => parseLanguagePluginManifest(manifest({ grammar: "grammar.js" }))).toThrow(".wasm");
    expect(() => parseLanguagePluginManifest(manifest({ structure: "rules" }))).toThrow("structure");
  });
});

describe("language plugins in the registry", () => {
  it("turns valid manifests into languages and explains the rest", () => {
    const entries = [
      { folder: "a", manifest: parseLanguagePluginManifest(manifest()) },
      { folder: "b", manifest: parseLanguagePluginManifest(manifest({ id: "python", extensions: ["pyx"] })) },
      { folder: "c", manifest: parseLanguagePluginManifest(manifest({ id: "broken", extensions: ["brk"], structure: { declarations: [{ node: "x", kind: "nope" }] } })) },
      { folder: "d", manifest: parseLanguagePluginManifest(manifest({ id: "jsonish", extensions: ["json", "jsonish"] })) },
      { folder: "e", error: "gitcrest-language.json is missing." },
    ];
    const { plugins, statuses } = definePlugins(entries, async () => new Uint8Array(), 1);
    expect(plugins.map((language) => language.id)).toEqual(["starlark", "jsonish"]);
    expect(statuses.map((status) => [status.folder, status.state])).toEqual([["a", "ready"], ["b", "error"], ["c", "error"], ["d", "ready"], ["e", "error"]]);
    expect(statuses[1]?.error).toContain("built-in language");
    expect(statuses[2]?.error).toContain("structure.declarations[0].kind");
    expect(statuses[3]?.shadowed).toEqual([".json"]);

    setLanguagePluginsForTesting(plugins, statuses);
    expect(languageForPath("tools/defs.BZL")?.id).toBe("starlark");
    expect(languageForPath("pkg/BUILD.bazel")?.id).toBe("starlark");
    // A built-in language keeps the file types it already handles.
    expect(languageForPath("package.json")?.id).toBe("json");
    expect(languageForPath("data.jsonish")?.id).toBe("jsonish");
    setLanguagePluginsForTesting([]);
  });

  it("reads a plugin language's structure from its rules and grammar", async () => {
    const validated = validateStructureRules(starlarkStructure);
    if (!validated.ok) throw new Error(validated.error);
    const read = (source: string) => parseWith(PYTHON_GRAMMAR, source, (root) => extractWithRules(root, validated.rules));
    const before = "load(\"//:defs.bzl\", \"x\")\n\n# Core library.\ncc_library(\n    name = \"core\",\n    srcs = [\"a.cc\"],\n)\n\ndef helper(ctx):\n    return ctx\n";
    expect((await read(before)).declarations.map((declaration) => declaration.key)).toEqual(["rule:core", "function:helper"]);

    const after = before.replace("srcs = [\"a.cc\"]", "srcs = [\"a.cc\", \"b.cc\"]");
    const { analysis } = await analyzeSources("BUILD.bazel", before, after, read);
    expect(factsOf(analysis, "rule:core")).toEqual(["declaration"]);
    expect(await readFile(PYTHON_GRAMMAR).then((bytes) => bytes.length)).toBeGreaterThan(0);
  });
});
