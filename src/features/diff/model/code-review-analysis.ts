import type { DiffDocumentResponse } from "../../../api/client";
import type { LanguageSyntax, LineRange, SourceDeclaration, StructureKind } from "../../languages";
import { compilePatterns, isAnnotationLine, MODIFIER_WORDS, sameTokens, splitComments, stripComments, tokens, words } from "./code-text";

/**
 * Groups the changed rows of one file diff by the code structure that owns them.
 *
 * The rows of the Git diff stay the only unit that can be selected: structures organise and describe
 * them, and a structure selection is always a set of existing `(hunkIndex, rowIndex)` pairs.
 */
export type DiffSide = "old" | "new";
export interface SideLine {
  side: DiffSide;
  line: number;
}

export type ChangeFactKind =
  | "added"
  | "removed"
  | "parameters"
  | "returnType"
  | "body"
  | "declaration"
  | "modifiers"
  | "annotations"
  | "comments"
  | "formatting"
  | "content"
  | "value"
  | "debug"
  | "members";
export interface ChangeFact {
  kind: ChangeFactKind;
  /** Where the evidence for this fact is, so the label can jump to it. */
  at: SideLine;
}

export interface RowSelection {
  hunkIndex: number;
  rowIndex: number;
  /** Only the deleted (old) or added (new) line of a row that has both. */
  side?: "old" | "new";
}

/** One changed row of the diff: a deleted line, an added line, or a deleted and an added line paired. */
export interface ReviewAtom {
  oldLine: number | null;
  newLine: number | null;
  /** Structures owning the row's lines; two or more make it a shared row. */
  owners: string[];
  /** Owners of the deleted line and of the added line, so a shared row can be split between them. */
  oldOwners: string[];
  newOwners: string[];
  oldText: string | null;
  newText: string | null;
  /** The added line matches one of the language's debug-output patterns. */
  debug: boolean;
  /** Names on the added line that appear nowhere in the old file. */
  introduces: string[];
  /** The row of the hunk document that stages or unstages this change, when one was given. */
  selection?: RowSelection;
}

export const OTHER_STRUCTURE_ID = "other:";

export interface ReviewStructure {
  /** Stable for the same declaration across refreshes: its kind and name path. */
  id: string;
  kind: StructureKind | "other";
  name: string;
  parentId: string | null;
  depth: number;
  status: "added" | "removed" | "modified";
  facts: ChangeFact[];
  /** Changed rows the structure owns directly, shared ones included. */
  atoms: number[];
  /** The subset of `atoms` that another structure also owns. */
  sharedAtoms: number[];
  /** Changed rows owned by nested structures, without the structure's own. */
  memberAtoms: number[];
  /** False when a parse error covers the structure, so it is shown but not described or selected as a unit. */
  reliable: boolean;
  anchor: SideLine;
  /** The parameter list shown after the name of an overload. */
  detail?: string;
  /** Its own changes only reformat code or only touch comments, so it can be set aside while reviewing. */
  noise?: "formatting" | "comments";
  /** Changes when any of the structure's own changed lines change; review marks only survive while it is equal. */
  fingerprint: string;
}

export interface CodeReviewAnalysis {
  /** Revision of the document whose rows `atoms[].selection` address. */
  revision: string;
  /** Changed structures and their ancestors in source order, then "other changes" when there are any. */
  structures: ReviewStructure[];
  atoms: ReviewAtom[];
  /** `hunkIndex:rowIndex` of the hunk document → index in `atoms`. */
  rowAtoms: Map<string, number>;
  /** True when parse errors left some changes without a reliable structure. */
  partial: boolean;
  /** Atoms whose added line is debug output. */
  debugAtoms: number[];
  /** A name new to the file → the changed rows that bring it in: import lines, or the declaration of an added structure. */
  definers: Map<string, number[]>;
}

export type CodeReviewResult =
  | { status: "ready"; analysis: CodeReviewAnalysis }
  /** The full file and the hunk document were not read from the same content. */
  | { status: "stale" };

export interface CodeReviewInput {
  /** A `context=full` document: its rows hold both complete files. */
  fullDocument: DiffDocumentResponse;
  /** The `context=hunks` document whose rows are staged; omitted for read-only navigation. */
  hunksDocument?: DiffDocumentResponse;
  oldDeclarations: SourceDeclaration[];
  newDeclarations: SourceDeclaration[];
  /** Either side's parse tree contains errors. */
  recovered: boolean;
  /** Comment markers and debug patterns of the file's language. */
  syntax?: LanguageSyntax;
}

export function rowKey(hunkIndex: number, rowIndex: number): string {
  return `${hunkIndex}:${rowIndex}`;
}

export function analyzeCodeReview(input: CodeReviewInput): CodeReviewResult {
  const { fullDocument, hunksDocument } = input;
  const atoms: ReviewAtom[] = [];
  const atomTexts: string[] = [];
  const blockOfAtom: number[] = [];
  const oldTextByLine: Array<string | undefined> = [];
  const newTextByLine: Array<string | undefined> = [];
  let block = -1;
  let previousWasChange = false;
  for (const hunk of fullDocument.hunks) {
    previousWasChange = false;
    for (const row of hunk.rows) {
      if (row.oldLine !== null && row.oldText !== null) oldTextByLine[row.oldLine] = row.oldText;
      if (row.newLine !== null && row.newText !== null) newTextByLine[row.newLine] = row.newText;
      if (row.kind !== "change") {
        previousWasChange = false;
        continue;
      }
      if (!previousWasChange) block += 1;
      previousWasChange = true;
      atoms.push({ oldLine: row.oldLine, newLine: row.newLine, owners: [], oldOwners: [], newOwners: [], oldText: row.oldText, newText: row.newText, debug: false, introduces: [] });
      atomTexts.push(`${row.oldText ?? ""}\u0000${row.newText ?? ""}`);
      blockOfAtom.push(block);
    }
  }

  const rowAtoms = new Map<string, number>();
  if (hunksDocument) {
    const atomByLines = new Map(atoms.map((atom, index) => [`${atom.oldLine ?? ""}:${atom.newLine ?? ""}`, index]));
    let matched = 0;
    for (const [hunkIndex, hunk] of hunksDocument.hunks.entries()) {
      for (const [rowIndex, row] of hunk.rows.entries()) {
        // Every line the hunk document shows must read the same in the full file.
        if (row.oldLine !== null && oldTextByLine[row.oldLine] !== row.oldText) return { status: "stale" };
        if (row.newLine !== null && newTextByLine[row.newLine] !== row.newText) return { status: "stale" };
        if (row.kind !== "change") continue;
        const atomIndex = atomByLines.get(`${row.oldLine ?? ""}:${row.newLine ?? ""}`);
        const atom = atomIndex === undefined ? undefined : atoms[atomIndex];
        if (atomIndex === undefined || !atom || atom.selection) return { status: "stale" };
        atom.selection = { hunkIndex, rowIndex };
        rowAtoms.set(rowKey(hunkIndex, rowIndex), atomIndex);
        matched += 1;
      }
    }
    if (matched !== atoms.length) return { status: "stale" };
  }

  const oldDeclarations = reconcileOverloads(input.oldDeclarations, input.newDeclarations);
  const oldOwners = paintOwners(oldDeclarations);
  const newOwners = paintOwners(input.newDeclarations);
  let partial = input.recovered;
  for (const atom of atoms) {
    atom.oldOwners = atom.oldLine === null ? [] : oldOwners.get(atom.oldLine) ?? [OTHER_STRUCTURE_ID];
    atom.newOwners = atom.newLine === null ? [] : newOwners.get(atom.newLine) ?? [OTHER_STRUCTURE_ID];
    atom.owners = [...new Set([...atom.oldOwners, ...atom.newOwners])];
  }
  adoptBlankLines(atoms, atomTexts, blockOfAtom);

  const syntax = input.syntax;
  const debugPatterns = compilePatterns(syntax?.debugPatterns);
  const oldWords = new Set<string>();
  for (const text of oldTextByLine) if (text !== undefined) for (const word of words(text, syntax)) oldWords.add(word);
  const debugAtoms: number[] = [];
  for (const [index, atom] of atoms.entries()) {
    if (atom.newText === null) continue;
    atom.debug = debugPatterns.some((pattern) => pattern.test(stripComments(atom.newText ?? "", syntax)));
    if (atom.debug) debugAtoms.push(index);
    atom.introduces = [...new Set(words(atom.newText, syntax).filter((word) => !oldWords.has(word)))];
  }

  const merged = mergeDeclarations(oldDeclarations, input.newDeclarations);
  const ownAtoms = new Map<string, number[]>();
  for (const [index, atom] of atoms.entries()) {
    for (const owner of atom.owners) {
      const list = ownAtoms.get(owner) ?? [];
      list.push(index);
      ownAtoms.set(owner, list);
    }
  }

  // A structure is listed when it or a nested structure owns a changed row.
  const listed = new Set<string>();
  for (const owner of ownAtoms.keys()) {
    let key: string | null = owner;
    while (key && merged.has(key) && !listed.has(key)) {
      listed.add(key);
      key = merged.get(key)?.parentKey ?? null;
    }
  }

  const memberAtoms = new Map<string, Set<number>>();
  for (const [owner, indexes] of ownAtoms) {
    let parent = merged.get(owner)?.parentKey ?? null;
    while (parent) {
      const set = memberAtoms.get(parent) ?? new Set<number>();
      for (const index of indexes) set.add(index);
      memberAtoms.set(parent, set);
      parent = merged.get(parent)?.parentKey ?? null;
    }
  }

  const structures: ReviewStructure[] = [];
  for (const entry of merged.values()) {
    if (!listed.has(entry.key)) continue;
    const own = ownAtoms.get(entry.key) ?? [];
    const ownSet = new Set(own);
    const members = [...(memberAtoms.get(entry.key) ?? [])].filter((index) => !ownSet.has(index)).sort((a, b) => a - b);
    const reliable = (entry.old?.reliable ?? true) && (entry.new?.reliable ?? true);
    if (!reliable && own.length) partial = true;
    const noise = reliable && entry.old && entry.new && !entry.ambiguous ? noiseOf(own, atoms, syntax) : undefined;
    const facts = reliable ? describe(entry, own, members, atoms, syntax) : [];
    const debugAtom = own.map((index) => atoms[index]).find((atom) => atom?.debug);
    structures.push({
      id: entry.key,
      kind: entry.kind,
      name: entry.name,
      parentId: entry.parentKey,
      depth: entry.depth,
      status: entry.old && entry.new ? "modified" : entry.new ? (entry.ambiguous ? "modified" : "added") : (entry.ambiguous ? "modified" : "removed"),
      // Formatting or comment changes replace the structure's own descriptions; member changes stay listed.
      facts: [
        ...(noise && own.length ? [{ kind: noise, at: atomLine(atoms[own[0]!]!) }] : facts.filter((fact) => fact.kind !== "members")),
        ...(debugAtom ? [{ kind: "debug" as const, at: atomLine(debugAtom) }] : []),
        ...facts.filter((fact) => fact.kind === "members"),
      ],
      ...(noise ? { noise } : {}),
      atoms: own,
      sharedAtoms: own.filter((index) => (atoms[index]?.owners.length ?? 0) > 1),
      memberAtoms: members,
      reliable,
      anchor: anchorOf(entry, own.length ? own : members, atoms),
      fingerprint: fingerprint(own.map((index) => atomTexts[index] ?? "")),
      ...(entry.new?.detail ?? entry.old?.detail ? { detail: entry.new?.detail ?? entry.old?.detail } : {}),
    });
  }

  const other = ownAtoms.get(OTHER_STRUCTURE_ID);
  if (other?.length) {
    structures.push({
      id: OTHER_STRUCTURE_ID,
      kind: "other",
      name: "",
      parentId: null,
      depth: 0,
      status: "modified",
      facts: [],
      atoms: other,
      sharedAtoms: other.filter((index) => (atoms[index]?.owners.length ?? 0) > 1),
      memberAtoms: [],
      reliable: true,
      anchor: anchorOf(null, other, atoms),
      fingerprint: fingerprint(other.map((index) => atomTexts[index] ?? "")),
    });
  }

  // Where a name new to the file comes from: an added import line, or the declaration line of an added structure.
  const definers = new Map<string, number[]>();
  const define = (name: string, index: number) => {
    const list = definers.get(name) ?? [];
    if (!list.includes(index)) list.push(index);
    definers.set(name, list);
  };
  for (const [index, atom] of atoms.entries()) {
    if (atom.newOwners.includes(IMPORTS_ID)) for (const name of atom.introduces) define(name, index);
  }
  for (const entry of merged.values()) {
    if (entry.old || !entry.new || entry.ambiguous) continue;
    const header = { start: entry.new.range.start, end: entry.new.bodyStart ?? entry.new.range.end };
    for (const index of ownAtoms.get(entry.key) ?? []) {
      const atom = atoms[index];
      if (atom?.newLine !== null && atom && within(atom.newLine, header) && atom.introduces.includes(entry.name)) define(entry.name, index);
    }
  }

  return {
    status: "ready",
    analysis: { revision: hunksDocument?.revision ?? fullDocument.revision, structures, atoms, rowAtoms, partial, debugAtoms, definers },
  };
}

const IMPORTS_ID = "imports:";

/** Whether a structure's own changes only reformat its code, or only touch its comments. */
function noiseOf(own: number[], atoms: ReviewAtom[], syntax: LanguageSyntax | undefined): "formatting" | "comments" | undefined {
  if (own.length === 0) return undefined;
  const before = own.map((index) => atoms[index]?.oldText).filter((text): text is string => text !== null && text !== undefined).join("\n");
  const after = own.map((index) => atoms[index]?.newText).filter((text): text is string => text !== null && text !== undefined).join("\n");
  if (before === after) return undefined;
  if (sameTokens(before, after)) return "formatting";
  if (syntax && sameTokens(stripComments(before, syntax), stripComments(after, syntax))) return "comments";
  return undefined;
}

/** Maps each line to the innermost declarations covering it; two of equal size on one line both own it. */
function paintOwners(declarations: SourceDeclaration[]): Map<number, string[]> {
  const owners = new Map<number, { span: number; keys: string[] }>();
  const ordered = [...declarations].sort((a, b) => span(b.range) - span(a.range));
  for (const declaration of ordered) {
    const size = span(declaration.range);
    for (const range of declaration.segments ?? [declaration.range]) {
      for (let line = range.start; line <= range.end; line += 1) {
        const current = owners.get(line);
        if (!current || current.span > size) owners.set(line, { span: size, keys: [declaration.key] });
        else if (current.span === size && !current.keys.includes(declaration.key)) current.keys.push(declaration.key);
      }
    }
  }
  return new Map([...owners].map(([line, entry]) => [line, entry.keys]));
}

function span(range: LineRange): number {
  return range.end - range.start + 1;
}

/**
 * Blank lines between declarations belong to none of them. When every other line of the same change
 * block belongs to one structure, as for a function added with its separating blank line, the blank
 * lines go with it.
 */
function adoptBlankLines(atoms: ReviewAtom[], texts: string[], blocks: number[]) {
  const blockOwners = new Map<number, Set<string>>();
  for (const [index, atom] of atoms.entries()) {
    if (isBlank(texts[index] ?? "")) continue;
    const block = blocks[index] ?? -1;
    const set = blockOwners.get(block) ?? new Set<string>();
    for (const owner of atom.owners) set.add(owner);
    blockOwners.set(block, set);
  }
  for (const [index, atom] of atoms.entries()) {
    if (!isBlank(texts[index] ?? "") || atom.owners.length !== 1 || atom.owners[0] !== OTHER_STRUCTURE_ID) continue;
    const owners = blockOwners.get(blocks[index] ?? -1);
    const only = owners?.size === 1 ? [...owners][0] : undefined;
    if (only && only !== OTHER_STRUCTURE_ID) {
      atom.owners = [only];
      if (atom.oldLine !== null) atom.oldOwners = [only];
      if (atom.newLine !== null) atom.newOwners = [only];
    }
  }
}

/** `text` is a row's old and new text joined by NUL. */
function isBlank(text: string): boolean {
  return /^[\s\u0000]*$/.test(text);
}

interface MergedDeclaration {
  key: string;
  kind: StructureKind;
  name: string;
  parentKey: string | null;
  depth: number;
  /** The key carries an ordinal, so its two sides were paired by position, not by a unique name. */
  ambiguous: boolean;
  old?: SourceDeclaration;
  new?: SourceDeclaration;
}

/** Pairs declarations with equal keys; source order follows the new side, with removed ones after their old neighbours. */
/**
 * A method that gains or loses an overload is keyed by name on one side and by name and parameters on
 * the other. Old declarations are re-keyed to the new key when exactly one new namesake has the same
 * parameter list, so the unchanged overload is not reported as removed and added.
 */
function reconcileOverloads(oldDeclarations: SourceDeclaration[], newDeclarations: SourceDeclaration[]): SourceDeclaration[] {
  const oldKeys = new Set(oldDeclarations.map((declaration) => declaration.key));
  const newKeys = new Set(newDeclarations.map((declaration) => declaration.key));
  const baseOf = (declaration: SourceDeclaration) => declaration.detail ? declaration.key.slice(0, -declaration.detail.length) : declaration.key;
  const renames = new Map<string, string>();
  for (const declaration of oldDeclarations) {
    if (newKeys.has(declaration.key) || declaration.parameters === undefined) continue;
    const candidates = newDeclarations.filter((candidate) => !oldKeys.has(candidate.key)
      && (candidate.detail !== undefined || declaration.detail !== undefined)
      && baseOf(candidate) === baseOf(declaration)
      && candidate.parameters === declaration.parameters);
    if (candidates.length === 1 && candidates[0]) renames.set(declaration.key, candidates[0].key);
  }
  if (renames.size === 0) return oldDeclarations;
  const rekey = (key: string | null) => {
    if (key === null) return null;
    for (const [from, to] of renames) {
      if (key === from) return to;
      if (key.startsWith(`${from}/`)) return `${to}/${key.slice(from.length + 1)}`;
    }
    return key;
  };
  return oldDeclarations.map((declaration) => ({ ...declaration, key: rekey(declaration.key) ?? declaration.key, parentKey: rekey(declaration.parentKey) }));
}

function mergeDeclarations(oldDeclarations: SourceDeclaration[], newDeclarations: SourceDeclaration[]): Map<string, MergedDeclaration> {
  const oldByKey = new Map(oldDeclarations.map((declaration) => [declaration.key, declaration]));
  const newByKey = new Map(newDeclarations.map((declaration) => [declaration.key, declaration]));
  const order: SourceDeclaration[] = [];
  const seen = new Set<string>();
  let oldCursor = 0;
  for (const declaration of newDeclarations) {
    const counterpart = oldByKey.get(declaration.key);
    if (counterpart) {
      // Emit removed declarations that came before the counterpart in the old file.
      const stop = oldDeclarations.indexOf(counterpart);
      for (; oldCursor < stop; oldCursor += 1) {
        const old = oldDeclarations[oldCursor];
        if (old && !newByKey.has(old.key) && !seen.has(old.key)) {
          order.push(old);
          seen.add(old.key);
        }
      }
      oldCursor = Math.max(oldCursor, stop + 1);
    }
    order.push(declaration);
    seen.add(declaration.key);
  }
  for (const old of oldDeclarations) {
    if (!seen.has(old.key)) {
      order.push(old);
      seen.add(old.key);
    }
  }

  const merged = new Map<string, MergedDeclaration>();
  for (const declaration of order) {
    merged.set(declaration.key, {
      key: declaration.key,
      kind: declaration.kind,
      name: declaration.name,
      parentKey: declaration.parentKey,
      depth: 0,
      ambiguous: declaration.key.includes("#") || Boolean(oldByKey.get(declaration.key)?.ambiguous || newByKey.get(declaration.key)?.ambiguous),
      old: oldByKey.get(declaration.key),
      new: newByKey.get(declaration.key),
    });
  }
  return sortTree(merged);
}

/** Puts every structure right after its parent's earlier children, keeping source order among siblings. */
function sortTree(merged: Map<string, MergedDeclaration>): Map<string, MergedDeclaration> {
  const childrenOf = new Map<string | null, MergedDeclaration[]>();
  for (const entry of merged.values()) {
    const parent = entry.parentKey && merged.has(entry.parentKey) ? entry.parentKey : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(entry);
    childrenOf.set(parent, list);
  }
  const sorted = new Map<string, MergedDeclaration>();
  const visit = (parent: string | null, depth: number) => {
    for (const entry of childrenOf.get(parent) ?? []) {
      sorted.set(entry.key, { ...entry, depth });
      visit(entry.key, depth + 1);
    }
  };
  visit(null, 0);
  return sorted;
}

const CONTAINERS = new Set<StructureKind>(["class", "impl", "trait", "module", "interface", "struct"]);
/** What a change outside any signature or body is called, where "declaration" would mislead: a Markdown section's text, a JSON key's value. */
const OWN_CHANGE_FACT: Partial<Record<StructureKind, ChangeFactKind>> = { section: "content", key: "value" };

function describe(entry: MergedDeclaration, own: number[], members: number[], atoms: ReviewAtom[], syntax?: LanguageSyntax): ChangeFact[] {
  const facts: ChangeFact[] = [];
  const firstMember = members[0] === undefined ? undefined : atoms[members[0]];
  const memberFact = firstMember ? [{ kind: "members" as const, at: atomLine(firstMember) }] : [];
  if (entry.ambiguous) return [];
  if (!entry.old && entry.new) return [{ kind: "added", at: { side: "new", line: entry.new.range.start } }];
  if (entry.old && !entry.new) return [{ kind: "removed", at: { side: "old", line: entry.old.range.start } }];
  const before = entry.old;
  const after = entry.new;
  if (!before || !after) return [];

  if (before.parameters !== after.parameters && (before.parameters !== undefined || after.parameters !== undefined)) {
    facts.push({ kind: "parameters", at: rangeLine(after.parametersRange, "new") ?? rangeLine(before.parametersRange, "old") ?? { side: "new", line: after.range.start } });
  }
  if (before.returnType !== after.returnType) {
    facts.push({ kind: "returnType", at: rangeLine(after.returnTypeRange, "new") ?? rangeLine(before.returnTypeRange, "old") ?? { side: "new", line: after.range.start } });
  }

  const isFunction = before.parameters !== undefined || after.parameters !== undefined;
  const hasBody = !CONTAINERS.has(entry.kind) && isFunction && (before.bodyStart !== undefined || after.bodyStart !== undefined);
  const inBody = (atom: ReviewAtom) => (atom.oldLine !== null && before.bodyStart !== undefined && atom.oldLine >= before.bodyStart)
    || (atom.newLine !== null && after.bodyStart !== undefined && atom.newLine >= after.bodyStart);
  const inSignature = (atom: ReviewAtom) => (atom.oldLine !== null && (within(atom.oldLine, before.parametersRange) || within(atom.oldLine, before.returnTypeRange)))
    || (atom.newLine !== null && (within(atom.newLine, after.parametersRange) || within(atom.newLine, after.returnTypeRange)));

  const ownAtoms = own.map((index) => atoms[index]).filter((atom): atom is ReviewAtom => atom !== undefined);
  // A whole function on one line cannot be split by lines; its changes count as body changes.
  const oneLine = hasBody && after.bodyStart !== undefined && after.range.end === after.bodyStart && after.parametersRange?.start === after.bodyStart;
  // A line holding both the signature and the body's opening brace belongs to the header.
  const isBody = (atom: ReviewAtom) => hasBody && inBody(atom) && (oneLine || !inSignature(atom));
  const bodyAtom = ownAtoms.find(isBody);
  const header = ownAtoms.filter((atom) => !isBody(atom));
  const ownChange = OWN_CHANGE_FACT[entry.kind] ?? "declaration";
  if (header[0]) {
    // Parameter and return-type changes are already named; what else changed in the header?
    const explained = tokenDifference(`${before.parameters ?? ""} ${before.returnType ?? ""}`, `${after.parameters ?? ""} ${after.returnType ?? ""}`, undefined);
    const kinds = ownChange === "declaration" ? headerChanges(header, syntax, explained) : [ownChange];
    for (const kind of kinds) facts.push({ kind, at: atomLine(header[0]) });
  }
  if (bodyAtom) facts.push({ kind: "body", at: atomLine(bodyAtom) });
  const first = ownAtoms[0];
  if (facts.length === 0 && first) facts.push({ kind: bodyAtom ? "body" : ownChange, at: atomLine(first) });
  facts.push(...memberFact);
  return facts;
}

/** Tokens added or removed between two texts, as signed counts. */
function tokenDifference(before: string, after: string, syntax: LanguageSyntax | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens(stripComments(before, syntax))) counts.set(token, (counts.get(token) ?? 0) - 1);
  for (const token of tokens(stripComments(after, syntax))) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, count] of counts) if (count === 0) counts.delete(token);
  return counts;
}

/**
 * Names a change to a declaration's header more precisely when it is only one thing: comments, modifier
 * keywords (`public`, `async`, `export`…), or annotation lines (`@Override`, `#[test]`).
 */
function headerChanges(header: ReviewAtom[], syntax: LanguageSyntax | undefined, explained: Map<string, number>): ChangeFactKind[] {
  const before = header.map((atom) => atom.oldText).filter((text): text is string => text !== null).join("\n");
  const after = header.map((atom) => atom.newText).filter((text): text is string => text !== null).join("\n");
  if (before === after) return [];
  const kinds: ChangeFactKind[] = [];
  const hasComments = Boolean(syntax?.lineComments?.length || syntax?.blockComments?.length);
  const code = tokenDifference(before, after, hasComments ? syntax : undefined);
  for (const [token, count] of explained) {
    const left = (code.get(token) ?? 0) - count;
    if (left === 0) code.delete(token);
    else code.set(token, left);
  }
  const changedLines = header
    .filter((atom) => atom.oldText !== atom.newText)
    .flatMap((atom) => [atom.oldText, atom.newText])
    .filter((text): text is string => text !== null && text.trim() !== "");
  if (code.size > 0) {
    if ([...code.keys()].every((token) => MODIFIER_WORDS.has(token))) kinds.push("modifiers");
    else if (changedLines.every(isAnnotationLine)) kinds.push("annotations");
    else kinds.push("declaration");
  }
  if (hasComments && !sameTokens(splitComments(before, syntax).comments, splitComments(after, syntax).comments)) kinds.push("comments");
  return kinds;
}

function within(line: number, range: LineRange | undefined): boolean {
  return range !== undefined && line >= range.start && line <= range.end;
}

function rangeLine(range: LineRange | undefined, side: DiffSide): SideLine | undefined {
  return range ? { side, line: range.start } : undefined;
}

function atomLine(atom: ReviewAtom): SideLine {
  return atom.newLine !== null ? { side: "new", line: atom.newLine } : { side: "old", line: atom.oldLine ?? 1 };
}

function anchorOf(entry: MergedDeclaration | null, indexes: number[], atoms: ReviewAtom[]): SideLine {
  const first = indexes[0] === undefined ? undefined : atoms[indexes[0]];
  if (first) return atomLine(first);
  if (entry?.new) return { side: "new", line: entry.new.range.start };
  if (entry?.old) return { side: "old", line: entry.old.range.start };
  return { side: "new", line: 1 };
}

/** FNV-1a over the changed lines, enough to tell whether a reviewed structure changed since. */
function fingerprint(texts: string[]): string {
  let hash = 0x811c9dc5;
  for (const text of texts) {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${texts.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * The row selections that stage a structure's changes. In a row shared with another structure only the
 * side this structure owns is taken (`halves` counts those); a row neither of whose sides it owns alone
 * is `withheld`. `touched` lists every part the structure has a share in, for clearing it again.
 */
export function structureSelection(
  analysis: CodeReviewAnalysis,
  id: string,
  includeMembers: boolean,
): { rows: RowSelection[]; touched: RowSelection[]; withheld: number; halves: number } {
  const ids = new Set([id]);
  if (includeMembers) {
    // Structures are listed parents first, so one pass collects every descendant.
    for (const structure of analysis.structures) {
      if (structure.parentId && ids.has(structure.parentId)) ids.add(structure.id);
    }
  }
  const owned = (owners: string[]) => owners.length > 0 && owners.every((owner) => ids.has(owner));
  const shares = (owners: string[]) => owners.some((owner) => ids.has(owner));
  const rows: RowSelection[] = [];
  const touched: RowSelection[] = [];
  let withheld = 0;
  let halves = 0;
  for (const atom of analysis.atoms) {
    if (!shares(atom.owners)) continue;
    const takesOld = atom.oldLine !== null && owned(atom.oldOwners);
    const takesNew = atom.newLine !== null && owned(atom.newOwners);
    const wholeRow = (atom.oldLine === null || takesOld) && (atom.newLine === null || takesNew);
    const side = wholeRow ? undefined : takesOld ? "old" as const : takesNew ? "new" as const : undefined;
    if (atom.selection) {
      const sharesOld = atom.oldLine !== null && shares(atom.oldOwners);
      const sharesNew = atom.newLine !== null && shares(atom.newOwners);
      const touchedSide = (atom.oldLine === null || sharesOld) && (atom.newLine === null || sharesNew)
        ? undefined
        : sharesOld ? "old" as const : "new" as const;
      touched.push(touchedSide ? { ...atom.selection, side: touchedSide } : atom.selection);
    }
    if (!wholeRow && !side) {
      withheld += 1;
      continue;
    }
    if (side) halves += 1;
    if (atom.selection) rows.push(side ? { ...atom.selection, side } : atom.selection);
  }
  return { rows, touched, withheld, halves };
}
