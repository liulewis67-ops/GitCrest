/** Declarations of JavaScript, TypeScript and Rust files: adapters written as code for their many special forms. */
import {
  childKey,
  children,
  compact,
  DeclarationCollector,
  forEachMember,
  functionParts as partsOf,
  lineRange,
  withLeading,
  type SourceDeclaration,
  type StructureKind,
  type SyntaxNodeLike,
} from "./structure-common";

export type StructureGrammar = "javascript" | "typescript" | "tsx" | "rust";

const LEADING_TRIVIA = new Set(["comment", "line_comment", "block_comment", "attribute_item", "decorator"]);

/** Lists the named declarations of a parsed file, outermost first. */
export function extractDeclarations(root: SyntaxNodeLike, grammar: StructureGrammar): SourceDeclaration[] {
  const collector = new DeclarationCollector();
  if (grammar === "rust") collectRust(root, null, collector);
  else collectScript(root, null, collector);
  return collector.finish();
}

function functionParts(node: SyntaxNodeLike) {
  return partsOf(node.childForFieldName("parameters"), node.childForFieldName("return_type"), node.childForFieldName("body"));
}

// JavaScript, TypeScript and TSX.

const SCRIPT_FUNCTIONS = new Set(["function_declaration", "generator_function_declaration", "function_signature"]);
const SCRIPT_CLASSES = new Set(["class_declaration", "abstract_class_declaration"]);
const SCRIPT_METHODS = new Set(["method_definition", "abstract_method_signature", "method_signature"]);
const SCRIPT_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function collectScript(container: SyntaxNodeLike, parentKey: string | null, collector: DeclarationCollector) {
  forEachMember(container, LEADING_TRIVIA, (node, leadingStart) => collectScriptNode(node, node, leadingStart, parentKey, collector));
}

function collectScriptNode(
  node: SyntaxNodeLike,
  outer: SyntaxNodeLike,
  leadingStart: number,
  parentKey: string | null,
  collector: DeclarationCollector,
) {
  const range = withLeading(lineRange(outer), leadingStart);
  const reliable = !outer.hasError;
  const name = node.childForFieldName("name")?.text ?? "";

  if (node.type === "import_statement" || (node.type === "export_statement" && node.childForFieldName("source"))) {
    if (parentKey === null) collector.addImport(range, reliable);
    return;
  }
  if (node.type === "export_statement") {
    const declaration = node.childForFieldName("declaration")
      ?? children(node).find((child) => SCRIPT_FUNCTIONS.has(child.type) || SCRIPT_CLASSES.has(child.type));
    if (declaration) collectScriptNode(declaration, outer, leadingStart, parentKey, collector);
    else if (parentKey === null && children(node).some((child) => child.type === "export_clause")) collector.addImport(range, reliable);
    return;
  }
  if (node.type === "expression_statement") {
    const inner = children(node)[0];
    if (inner && (inner.type === "internal_module" || inner.type === "module")) collectScriptNode(inner, outer, leadingStart, parentKey, collector);
    return;
  }
  if (SCRIPT_FUNCTIONS.has(node.type) && name) {
    collector.add({ baseKey: childKey(parentKey, "function", name), kind: "function", name, parentKey, range, reliable, ...functionParts(node) });
    return;
  }
  if (SCRIPT_CLASSES.has(node.type) && name) {
    const entry = collector.add({ baseKey: childKey(parentKey, "class", name), kind: "class", name, parentKey, range, reliable, bodyStart: bodyStartOf(node) });
    const body = node.childForFieldName("body");
    if (body) collectScriptClassBody(body, entry.key, collector);
    return;
  }
  if ((node.type === "internal_module" || node.type === "module") && name) {
    const entry = collector.add({ baseKey: childKey(parentKey, "module", name), kind: "module", name, parentKey, range, reliable, bodyStart: bodyStartOf(node) });
    const body = node.childForFieldName("body");
    if (body) collectScript(body, entry.key, collector);
    return;
  }
  if (node.type === "interface_declaration" && name) {
    collector.add({ baseKey: childKey(parentKey, "interface", name), kind: "interface", name, parentKey, range, reliable });
    return;
  }
  if (node.type === "type_alias_declaration" && name) {
    collector.add({ baseKey: childKey(parentKey, "type", name), kind: "type", name, parentKey, range, reliable });
    return;
  }
  if (node.type === "enum_declaration" && name) {
    collector.add({ baseKey: childKey(parentKey, "enum", name), kind: "enum", name, parentKey, range, reliable });
    return;
  }
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const declarators = children(node).filter((child) => child.type === "variable_declarator");
    const names = declarators.map((declarator) => declarator.childForFieldName("name")?.text ?? "").filter(Boolean);
    if (names.length === 0) return;
    const value = declarators.length === 1 ? declarators[0]?.childForFieldName("value") : null;
    if (value && SCRIPT_FUNCTION_VALUES.has(value.type)) {
      const declaredName = names[0] ?? "";
      collector.add({ baseKey: childKey(parentKey, "function", declaredName), kind: "function", name: declaredName, parentKey, range, reliable, ...functionParts(value) });
      return;
    }
    const joined = names.join(", ");
    collector.add({ baseKey: childKey(parentKey, "constant", joined), kind: "constant", name: joined, parentKey, range, reliable });
  }
}

/** Matches `get`/`set` after any decorators and modifiers at the start of a class member. */
const ACCESSOR = /^(?:@[^\n]*\n\s*)*(?:(?:public|private|protected|static|override|readonly|declare|abstract|async)\s+)*((?:get|set)\s)/;

function collectScriptClassBody(body: SyntaxNodeLike, parentKey: string, collector: DeclarationCollector) {
  forEachMember(body, LEADING_TRIVIA, (member, leadingStart) => {
    const range = withLeading(lineRange(member), leadingStart);
    const name = member.childForFieldName("name")?.text ?? "";
    if (!name) return;
    if (SCRIPT_METHODS.has(member.type)) {
      // Getters and setters share a name; the accessor keyword keeps them apart.
      const label = `${ACCESSOR.exec(member.text)?.[1] ?? ""}${name}`;
      collector.add({ baseKey: childKey(parentKey, "method", label), kind: "method", name: label, parentKey, range, reliable: !member.hasError, ...functionParts(member) });
    } else if (member.type === "public_field_definition" || member.type === "field_definition") {
      const value = member.childForFieldName("value");
      const parts = value && SCRIPT_FUNCTION_VALUES.has(value.type) ? functionParts(value) : {};
      collector.add({ baseKey: childKey(parentKey, "property", name), kind: "property", name, parentKey, range, reliable: !member.hasError, ...parts });
    }
  });
}

function bodyStartOf(node: SyntaxNodeLike): number | undefined {
  const body = node.childForFieldName("body");
  return body ? body.startPosition.row + 1 : undefined;
}

// Rust.

const RUST_SIMPLE: Record<string, StructureKind> = {
  struct_item: "struct",
  union_item: "struct",
  enum_item: "enum",
  type_item: "type",
  const_item: "constant",
  static_item: "constant",
  macro_definition: "macro",
};

function collectRust(container: SyntaxNodeLike, parent: SourceDeclaration | null, collector: DeclarationCollector) {
  forEachMember(container, LEADING_TRIVIA, (node, leadingStart) => {
    const range = withLeading(lineRange(node), leadingStart);
    const reliable = !node.hasError;
    const parentKey = parent?.key ?? null;
    const name = node.childForFieldName("name")?.text ?? "";

    if (node.type === "use_declaration" || node.type === "extern_crate_declaration") {
      if (parent === null) collector.addImport(range, reliable);
      return;
    }
    if (node.type === "function_item" || node.type === "function_signature_item") {
      if (!name) return;
      const kind: StructureKind = parent && (parent.kind === "impl" || parent.kind === "trait") ? "method" : "function";
      collector.add({ baseKey: childKey(parentKey, kind, name), kind, name, parentKey, range, reliable, ...functionParts(node) });
      return;
    }
    const simple = RUST_SIMPLE[node.type];
    if (simple && name) {
      collector.add({ baseKey: childKey(parentKey, simple, name), kind: simple, name, parentKey, range, reliable, bodyStart: bodyStartOf(node) });
      return;
    }
    if (node.type === "impl_item") {
      const type = node.childForFieldName("type")?.text;
      if (!type) return;
      const trait = node.childForFieldName("trait")?.text;
      const label = compact(trait ? `${trait} for ${type}` : type);
      const entry = collector.add({ baseKey: childKey(parentKey, "impl", label), kind: "impl", name: label, parentKey, range, reliable, bodyStart: bodyStartOf(node) });
      const body = node.childForFieldName("body");
      if (body) collectRust(body, entry, collector);
      return;
    }
    if ((node.type === "trait_item" || node.type === "mod_item") && name) {
      const kind: StructureKind = node.type === "trait_item" ? "trait" : "module";
      const entry = collector.add({ baseKey: childKey(parentKey, kind, name), kind, name, parentKey, range, reliable, bodyStart: bodyStartOf(node) });
      const body = node.childForFieldName("body");
      if (body) collectRust(body, entry, collector);
    }
  });
}
