import type { LanguageSyntax } from "./builtin-languages";
import {
  childKey,
  children,
  compact,
  DeclarationCollector,
  forEachMember,
  functionParts,
  lineRange,
  STRUCTURE_KINDS,
  withLeading,
  type SourceDeclaration,
  type StructureKind,
  type SyntaxNodeLike,
} from "./structure-common";

/**
 * Declarative structure rules: which syntax nodes of a tree-sitter grammar are named declarations,
 * and how to read their name, parameters, return type and body.
 *
 * Built-in languages and external language plugins are described the same way. Rules are data, so a
 * plugin never runs code inside GitCrest; the grammar itself is sandboxed WebAssembly.
 */

/** One step from a node towards a child: by grammar field name, or the first named child of a node type. */
export type NodeStep = { field: string } | { child: string };

export interface TextSource {
  /** Steps from the declaration node; an empty path reads the declaration node itself. Default: `[{ field: "name" }]`. */
  path?: NodeStep[];
  /** Applied to the text with whitespace collapsed; the first capture group (or the whole match) is used. No match means no name. */
  pattern?: string;
  /** Removes one pair of surrounding quotes, as for JSON keys. */
  unquote?: boolean;
  /** Written before the text, e.g. `@keyframes `. */
  prefix?: string;
}

export interface DeclarationRule {
  /** The syntax node type this rule describes. */
  node: string;
  kind: StructureKind;
  name?: TextSource;
  /** Picks the kind from the node type found at `path`, e.g. Go's `type X struct` versus `type X interface`. */
  kindFrom?: { path: NodeStep[]; map: Record<string, StructureKind> };
  /** The kind to use inside a structure of the given kind, e.g. a function inside a class is a method. */
  kindInside?: Partial<Record<StructureKind, StructureKind>>;
  /** Written before the name with a dot, e.g. the receiver type of a Go method. */
  qualifier?: TextSource;
  parameters?: NodeStep[];
  returnType?: NodeStep[];
  body?: NodeStep[];
  /** Looks for nested declarations inside `body`, which makes this structure a container. */
  members?: boolean;
}

export interface StructureRules {
  /** Node types of imports, exports and package lines, listed together as one module-level item. */
  imports?: string[];
  /** Node types written directly above a declaration that belong to it, such as comments and attributes. */
  leading?: string[];
  /** Node types whose named children are read as if they stood in their place, such as a JSON document's object. */
  transparent?: string[];
  /**
   * Node types that wrap declarations, such as decorators or Go's `type ( … )` groups. A wrapper around a
   * single declaration lends it its range, so decorators belong to the function they decorate.
   */
  wrappers?: string[];
  declarations: DeclarationRule[];
}

const MAX_TEXT_UNITS = 300;
const MAX_NAME_UNITS = 120;

/** Lists the named declarations of a parsed file according to the rules, outermost first. */
export function extractWithRules(root: SyntaxNodeLike, rules: StructureRules): SourceDeclaration[] {
  const compiled = compileRules(rules);
  const collector = new DeclarationCollector();
  collect(root, null, compiled, collector);
  return collector.finish();
}

interface CompiledRules {
  imports: ReadonlySet<string>;
  leading: ReadonlySet<string>;
  transparent: ReadonlySet<string>;
  wrappers: ReadonlySet<string>;
  byNode: ReadonlyMap<string, DeclarationRule>;
  patterns: Map<string, RegExp>;
}

const compiledCache = new WeakMap<StructureRules, CompiledRules>();

function compileRules(rules: StructureRules): CompiledRules {
  const cached = compiledCache.get(rules);
  if (cached) return cached;
  const compiled: CompiledRules = {
    imports: new Set(rules.imports ?? []),
    leading: new Set(rules.leading ?? []),
    transparent: new Set(rules.transparent ?? []),
    wrappers: new Set(rules.wrappers ?? []),
    byNode: new Map(rules.declarations.map((rule) => [rule.node, rule])),
    patterns: new Map(),
  };
  compiledCache.set(rules, compiled);
  return compiled;
}

function collect(container: SyntaxNodeLike, parent: SourceDeclaration | null, rules: CompiledRules, collector: DeclarationCollector) {
  forEachMember(container, rules.leading, (node, leadingStart) => visit(node, withLeading(lineRange(node), leadingStart), parent, rules, collector));
}

function visit(node: SyntaxNodeLike, range: { start: number; end: number }, parent: SourceDeclaration | null, rules: CompiledRules, collector: DeclarationCollector) {
  if (rules.imports.has(node.type)) {
    if (parent === null) collector.addImport(range, !node.hasError);
    return;
  }
  if (rules.transparent.has(node.type)) {
    collect(node, parent, rules, collector);
    return;
  }
  if (rules.wrappers.has(node.type)) {
    const inner = children(node).filter((child) => rules.byNode.has(child.type) || rules.wrappers.has(child.type) || rules.imports.has(child.type));
    // A wrapper around one declaration lends it its range (decorators, `export`); a group keeps each member's own.
    for (const child of inner) visit(child, inner.length === 1 ? range : lineRange(child), parent, rules, collector);
    return;
  }
  const rule = rules.byNode.get(node.type);
  if (!rule) return;
  const name = readText(node, rule.name ?? {}, rules);
  if (!name) return;
  const qualifier = rule.qualifier ? readText(node, rule.qualifier, rules) : undefined;
  const displayName = qualifier ? `${qualifier}.${name}` : name;
  let kind = rule.kind;
  if (rule.kindFrom) {
    const target = follow(node, rule.kindFrom.path);
    kind = (target && rule.kindFrom.map[target.type]) || kind;
  }
  if (parent && rule.kindInside?.[parent.kind]) kind = rule.kindInside[parent.kind] ?? kind;
  const body = rule.body ? follow(node, rule.body) : null;
  const parts = functionParts(
    rule.parameters ? follow(node, rule.parameters) : null,
    rule.returnType ? follow(node, rule.returnType) : null,
    body,
  );
  const entry = collector.add({
    baseKey: childKey(parent?.key ?? null, kind, displayName),
    kind,
    name: displayName,
    parentKey: parent?.key ?? null,
    range,
    reliable: !node.hasError,
    ...parts,
    // Only declarations with a parameter list describe changes after their opening line as body changes.
    bodyStart: rule.parameters || rule.members ? parts.bodyStart : undefined,
  });
  if (rule.members && body) collect(body, entry, rules, collector);
}

function follow(node: SyntaxNodeLike, path: NodeStep[]): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  for (const step of path) {
    if (!current) return null;
    current = "field" in step
      ? current.childForFieldName(step.field)
      : children(current).find((child) => child.type === step.child) ?? null;
  }
  return current;
}

function readText(node: SyntaxNodeLike, source: TextSource, rules: CompiledRules): string | undefined {
  const target = follow(node, source.path ?? [{ field: "name" }]);
  if (!target) return undefined;
  let text = compact(target.text.slice(0, MAX_TEXT_UNITS * 4)).slice(0, MAX_TEXT_UNITS);
  if (source.pattern) {
    let pattern = rules.patterns.get(source.pattern);
    if (!pattern) {
      pattern = new RegExp(source.pattern, "u");
      rules.patterns.set(source.pattern, pattern);
    }
    const match = pattern.exec(text);
    if (!match) return undefined;
    text = (match[1] ?? match[0]).trim();
  }
  if (source.unquote) text = text.replace(/^(["'`])([\s\S]*)\1$/u, "$2");
  if (!text) return undefined;
  const named = `${source.prefix ?? ""}${text}`;
  return named.length > MAX_NAME_UNITS ? `${named.slice(0, MAX_NAME_UNITS - 1)}…` : named;
}

/** Checks a plugin's optional comment markers and debug patterns, returning a clean copy. */
export function validateLanguageSyntax(value: unknown): { ok: true; syntax: LanguageSyntax } | { ok: false; error: string } {
  try {
    if (!isRecord(value)) fail("syntax", "expected an object");
    onlyKeys(value, ["lineComments", "blockComments", "debugPatterns"], "syntax");
    const marker = (item: unknown, path: string) => {
      if (typeof item !== "string" || item.length === 0 || item.length > 5 || /\s/.test(item)) fail(path, "expected 1 to 5 characters without spaces");
      return item;
    };
    const syntax: LanguageSyntax = {};
    if (value.lineComments !== undefined) {
      if (!Array.isArray(value.lineComments) || value.lineComments.length > 5) fail("syntax.lineComments", "expected a list of at most 5 markers");
      syntax.lineComments = value.lineComments.map((item, index) => marker(item, `syntax.lineComments[${index}]`));
    }
    if (value.blockComments !== undefined) {
      if (!Array.isArray(value.blockComments) || value.blockComments.length > 5) fail("syntax.blockComments", "expected a list of at most 5 pairs");
      syntax.blockComments = value.blockComments.map((pair, index) => {
        if (!Array.isArray(pair) || pair.length !== 2) fail(`syntax.blockComments[${index}]`, "expected [open, close]");
        return [marker(pair[0], `syntax.blockComments[${index}][0]`), marker(pair[1], `syntax.blockComments[${index}][1]`)] as [string, string];
      });
    }
    if (value.debugPatterns !== undefined) {
      if (!Array.isArray(value.debugPatterns) || value.debugPatterns.length > 20) fail("syntax.debugPatterns", "expected a list of at most 20 regular expressions");
      syntax.debugPatterns = value.debugPatterns.map((pattern, index) => {
        if (typeof pattern !== "string" || pattern.length > LIMITS.pattern) fail(`syntax.debugPatterns[${index}]`, `expected a regular expression of at most ${LIMITS.pattern} characters`);
        try {
          new RegExp(pattern, "u");
        } catch {
          fail(`syntax.debugPatterns[${index}]`, "is not a valid regular expression");
        }
        return pattern;
      });
    }
    return { ok: true, syntax };
  } catch (error) {
    return { ok: false, error: error instanceof RuleError ? error.message : "Syntax could not be read." };
  }
}

// Validation of rules that come from outside GitCrest, such as a language plugin's manifest.

const LIMITS = { types: 200, declarations: 300, steps: 6, identifier: 80, pattern: 200, prefix: 40, mapEntries: 40 };
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = new Set<string>(STRUCTURE_KINDS);

export type RulesValidation = { ok: true; rules: StructureRules } | { ok: false; error: string };

/** Checks untrusted rules against the format and its size limits, returning a clean copy. */
export function validateStructureRules(value: unknown): RulesValidation {
  try {
    return { ok: true, rules: readRules(value) };
  } catch (error) {
    return { ok: false, error: error instanceof RuleError ? error.message : "Structure rules could not be read." };
  }
}

class RuleError extends Error {}

function fail(path: string, problem: string): never {
  throw new RuleError(`${path}: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path, `unknown property "${key}"`);
}

function readIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > LIMITS.identifier || !IDENTIFIER.test(value)) fail(path, "expected a syntax node or field name");
  return value;
}

function readTypes(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > LIMITS.types) fail(path, `expected a list of at most ${LIMITS.types} node types`);
  return value.map((item, index) => readIdentifier(item, `${path}[${index}]`));
}

function readKind(value: unknown, path: string): StructureKind {
  if (typeof value !== "string" || !KINDS.has(value) || value === "imports") fail(path, `expected one of ${STRUCTURE_KINDS.filter((kind) => kind !== "imports").join(", ")}`);
  return value as StructureKind;
}

function readPath(value: unknown, path: string): NodeStep[] {
  if (!Array.isArray(value) || value.length > LIMITS.steps) fail(path, `expected a list of at most ${LIMITS.steps} steps`);
  return value.map((step, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(step)) fail(at, "expected { field } or { child }");
    onlyKeys(step, ["field", "child"], at);
    if ("field" in step && !("child" in step)) return { field: readIdentifier(step.field, `${at}.field`) };
    if ("child" in step && !("field" in step)) return { child: readIdentifier(step.child, `${at}.child`) };
    return fail(at, "expected exactly one of field or child");
  });
}

function readTextSource(value: unknown, path: string): TextSource | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail(path, "expected an object");
  onlyKeys(value, ["path", "pattern", "unquote", "prefix"], path);
  const source: TextSource = {};
  if (value.path !== undefined) source.path = readPath(value.path, `${path}.path`);
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== "string" || value.pattern.length > LIMITS.pattern) fail(`${path}.pattern`, `expected a regular expression of at most ${LIMITS.pattern} characters`);
    try {
      new RegExp(value.pattern, "u");
    } catch {
      fail(`${path}.pattern`, "is not a valid regular expression");
    }
    source.pattern = value.pattern;
  }
  if (value.unquote !== undefined) {
    if (typeof value.unquote !== "boolean") fail(`${path}.unquote`, "expected true or false");
    source.unquote = value.unquote;
  }
  if (value.prefix !== undefined) {
    if (typeof value.prefix !== "string" || value.prefix.length > LIMITS.prefix) fail(`${path}.prefix`, `expected text of at most ${LIMITS.prefix} characters`);
    source.prefix = value.prefix;
  }
  return source;
}

function readKindMap(value: unknown, path: string, keys: "nodes" | "kinds"): Record<string, StructureKind> {
  if (!isRecord(value) || Object.keys(value).length > LIMITS.mapEntries) fail(path, `expected an object of at most ${LIMITS.mapEntries} entries`);
  const map: Record<string, StructureKind> = {};
  for (const [key, kind] of Object.entries(value)) {
    if (keys === "kinds") readKind(key, `${path} key`);
    else readIdentifier(key, `${path} key`);
    map[key] = readKind(kind, `${path}.${key}`);
  }
  return map;
}

function readRule(value: unknown, path: string): DeclarationRule {
  if (!isRecord(value)) fail(path, "expected an object");
  onlyKeys(value, ["node", "kind", "name", "kindFrom", "kindInside", "qualifier", "parameters", "returnType", "body", "members"], path);
  const rule: DeclarationRule = { node: readIdentifier(value.node, `${path}.node`), kind: readKind(value.kind, `${path}.kind`) };
  const name = readTextSource(value.name, `${path}.name`);
  if (name) rule.name = name;
  if (value.kindFrom !== undefined) {
    if (!isRecord(value.kindFrom)) fail(`${path}.kindFrom`, "expected { path, map }");
    onlyKeys(value.kindFrom, ["path", "map"], `${path}.kindFrom`);
    rule.kindFrom = { path: readPath(value.kindFrom.path, `${path}.kindFrom.path`), map: readKindMap(value.kindFrom.map, `${path}.kindFrom.map`, "nodes") };
  }
  if (value.kindInside !== undefined) rule.kindInside = readKindMap(value.kindInside, `${path}.kindInside`, "kinds");
  const qualifier = readTextSource(value.qualifier, `${path}.qualifier`);
  if (qualifier) rule.qualifier = qualifier;
  if (value.parameters !== undefined) rule.parameters = readPath(value.parameters, `${path}.parameters`);
  if (value.returnType !== undefined) rule.returnType = readPath(value.returnType, `${path}.returnType`);
  if (value.body !== undefined) rule.body = readPath(value.body, `${path}.body`);
  if (value.members !== undefined) {
    if (typeof value.members !== "boolean") fail(`${path}.members`, "expected true or false");
    rule.members = value.members;
  }
  if (rule.members && !rule.body) fail(path, "members needs a body path");
  return rule;
}

function readRules(value: unknown): StructureRules {
  if (!isRecord(value)) fail("structure", "expected an object");
  onlyKeys(value, ["imports", "leading", "transparent", "wrappers", "declarations"], "structure");
  if (!Array.isArray(value.declarations) || value.declarations.length === 0 || value.declarations.length > LIMITS.declarations) {
    fail("structure.declarations", `expected 1 to ${LIMITS.declarations} rules`);
  }
  const declarations = value.declarations.map((rule, index) => readRule(rule, `structure.declarations[${index}]`));
  const seen = new Set<string>();
  for (const [index, rule] of declarations.entries()) {
    if (seen.has(rule.node)) fail(`structure.declarations[${index}].node`, `"${rule.node}" already has a rule`);
    seen.add(rule.node);
  }
  const rules: StructureRules = { declarations };
  const imports = readTypes(value.imports, "structure.imports");
  const leading = readTypes(value.leading, "structure.leading");
  const transparent = readTypes(value.transparent, "structure.transparent");
  const wrappers = readTypes(value.wrappers, "structure.wrappers");
  if (imports) rules.imports = imports;
  if (leading) rules.leading = leading;
  if (transparent) rules.transparent = transparent;
  if (wrappers) rules.wrappers = wrappers;
  return rules;
}
