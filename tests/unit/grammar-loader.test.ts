// @vitest-environment node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LanguageDefinition } from "../../src/features/languages/model/builtin-languages";

// In the app Vite serves the runtime's .wasm; here it is read from node_modules.
vi.mock("../../node_modules/@willbooster/web-tree-sitter/web-tree-sitter.wasm?url", () => ({
  default: resolve("node_modules/@willbooster/web-tree-sitter/web-tree-sitter.wasm"),
}));

const { createParser, declarationsFromTree } = await import("../../src/features/languages/model/grammar-loader");
const { getLanguageRegistry, setLanguagePluginsForTesting } = await import("../../src/features/languages/model/language-registry");

function plugin(id: string, bytes: () => Promise<Uint8Array>): LanguageDefinition {
  return {
    id,
    name: id,
    extensions: [id],
    monacoLanguage: "plaintext",
    grammar: { bytes },
    structure: { type: "rules", rules: { declarations: [{ node: "function_definition", kind: "function", parameters: [{ field: "parameters" }], body: [{ field: "body" }] }] } },
    source: "plugin",
    version: "1#1",
  };
}

describe("grammar loader", () => {
  it("creates a parser from a plugin's grammar bytes on first use", async () => {
    const language = plugin("pythonish", async () => new Uint8Array(await readFile("node_modules/tree-sitter-python/tree-sitter-python.wasm")));
    const parser = await createParser(language);
    const tree = parser.parse("def a(x):\n    return x\n")!;
    expect(declarationsFromTree(language, tree.rootNode).map((declaration) => declaration.key)).toEqual(["function:a"]);
    tree.delete();
    parser.delete();
  });

  it("records why a plugin's grammar cannot be used", async () => {
    const broken = plugin("broken", async () => new Uint8Array([0, 1, 2, 3]));
    setLanguagePluginsForTesting([broken], [{ folder: "broken", id: "broken", name: "broken", extensions: ["broken"], fileNames: [], state: "ready", shadowed: [] }]);

    await expect(createParser(broken)).rejects.toThrow();
    const status = getLanguageRegistry().statuses.find((entry) => entry.id === "broken");
    expect(status?.state).toBe("error");
    expect(status?.error).toContain("The grammar could not be used");
    expect(getLanguageRegistry().plugins).toEqual([]);
    setLanguagePluginsForTesting([]);
  });
});
