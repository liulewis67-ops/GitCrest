/**
 * Named declarations of one complete source file, and the pieces every language adapter shares to
 * read them from a tree-sitter tree.
 *
 * Only the shapes of the syntax nodes adapters read are declared, so callers can pass a
 * `web-tree-sitter` node and tests can build trees with the same parser.
 */
export interface SyntaxPoint {
  row: number;
  column: number;
}

export interface SyntaxNodeLike {
  type: string;
  text: string;
  startPosition: SyntaxPoint;
  endPosition: SyntaxPoint;
  hasError: boolean;
  namedChildren: Array<SyntaxNodeLike | null>;
  childForFieldName(name: string): SyntaxNodeLike | null;
}

export const STRUCTURE_KINDS = [
  "imports",
  "function",
  "method",
  "property",
  "variable",
  "constant",
  "class",
  "interface",
  "struct",
  "enum",
  "trait",
  "impl",
  "module",
  "type",
  "macro",
  "rule",
  "section",
  "key",
] as const;

export type StructureKind = typeof STRUCTURE_KINDS[number];

/** 1-based, inclusive line range on one side of the diff. */
export interface LineRange {
  start: number;
  end: number;
}

export interface SourceDeclaration {
  /** Kind and name path, e.g. `class:UserClient/method:loadUser`; equal keys on both sides are one structure. */
  key: string;
  kind: StructureKind;
  name: string;
  parentKey: string | null;
  /** The declaration with the comments and attributes written directly above it. */
  range: LineRange;
  /** Parameter list text, for functions and methods. */
  parameters?: string;
  parametersRange?: LineRange;
  /** Declared return type text, when the source spells one out. */
  returnType?: string;
  returnTypeRange?: LineRange;
  /** First line of the body, for declarations that have one. */
  bodyStart?: number;
  /** Lines the declaration actually covers when they are not one block, as for the imports group. */
  segments?: LineRange[];
  /** False when a parse error lies inside, so no facts or selections are derived from it. */
  reliable: boolean;
}

const IMPORTS_KEY = "imports:";

export class DeclarationCollector {
  private readonly declarations: SourceDeclaration[] = [];
  private readonly keyCounts = new Map<string, number>();
  private imports: SourceDeclaration | null = null;

  add(declaration: Omit<SourceDeclaration, "key"> & { baseKey: string }): SourceDeclaration {
    // Repeated names in one container (overloads, several `impl S` blocks) get an ordinal, so keys stay unique per side.
    const count = (this.keyCounts.get(declaration.baseKey) ?? 0) + 1;
    this.keyCounts.set(declaration.baseKey, count);
    const { baseKey, ...rest } = declaration;
    const entry: SourceDeclaration = { ...rest, key: count === 1 ? baseKey : `${baseKey}#${count}` };
    this.declarations.push(entry);
    return entry;
  }

  /** Every import or re-export of the file is one module-level group; only its statements' lines belong to it. */
  addImport(range: LineRange, reliable: boolean) {
    if (!this.imports) {
      this.imports = { key: IMPORTS_KEY, kind: "imports", name: "", parentKey: null, range: { ...range }, segments: [], reliable };
      this.declarations.push(this.imports);
    }
    this.imports.range = { start: Math.min(this.imports.range.start, range.start), end: Math.max(this.imports.range.end, range.end) };
    this.imports.segments?.push(range);
    this.imports.reliable &&= reliable;
  }

  finish(): SourceDeclaration[] {
    return this.declarations;
  }
}

export function lineRange(node: SyntaxNodeLike): LineRange {
  const start = node.startPosition.row + 1;
  // A node ending at column 0 stops before that line.
  const endRow = node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row ? node.endPosition.row - 1 : node.endPosition.row;
  return { start, end: endRow + 1 };
}

export function children(node: SyntaxNodeLike): SyntaxNodeLike[] {
  return node.namedChildren.filter((child): child is SyntaxNodeLike => child !== null);
}

export function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function childKey(parentKey: string | null, kind: StructureKind, name: string): string {
  const own = `${kind}:${name}`;
  return parentKey ? `${parentKey}/${own}` : own;
}

/**
 * Walks the named children of a container, pairing each declaration with the comments and attributes
 * (the `leading` node types) written on the lines directly above it.
 */
export function forEachMember(container: SyntaxNodeLike, leading: ReadonlySet<string>, visit: (node: SyntaxNodeLike, leadingStart: number) => void) {
  let triviaStart: number | null = null;
  let previousEnd = -1;
  for (const child of children(container)) {
    const range = lineRange(child);
    if (leading.has(child.type)) {
      // A blank line between comments breaks the run; a trailing comment on a code line never leads.
      const touches = triviaStart !== null && range.start <= previousEnd + 1;
      if (!touches) triviaStart = range.start > previousEnd ? range.start : null;
      previousEnd = range.end;
      continue;
    }
    const leadingStart = triviaStart !== null && range.start <= previousEnd + 1 ? triviaStart : range.start;
    visit(child, leadingStart);
    triviaStart = null;
    previousEnd = range.end;
  }
}

export function withLeading(range: LineRange, leadingStart: number): LineRange {
  return { start: Math.min(range.start, leadingStart), end: range.end };
}

/** Parameters, return type and body of a function-like node, read from the given child nodes. */
export function functionParts(parameters: SyntaxNodeLike | null, returnType: SyntaxNodeLike | null, body: SyntaxNodeLike | null) {
  return {
    parameters: parameters ? compact(parameters.text) : undefined,
    parametersRange: parameters ? lineRange(parameters) : undefined,
    returnType: returnType ? compact(returnType.text) : undefined,
    returnTypeRange: returnType ? lineRange(returnType) : undefined,
    bodyStart: body ? body.startPosition.row + 1 : undefined,
  };
}
