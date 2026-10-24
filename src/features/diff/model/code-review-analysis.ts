import type { DiffDocumentResponse } from "../../../api/client";
import type { LineRange, SourceDeclaration, StructureKind } from "../../languages";

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

export type ChangeFactKind = "added" | "removed" | "parameters" | "returnType" | "body" | "declaration" | "content" | "value" | "members";
export interface ChangeFact {
  kind: ChangeFactKind;
  /** Where the evidence for this fact is, so the label can jump to it. */
  at: SideLine;
}

export interface RowSelection {
  hunkIndex: number;
  rowIndex: number;
}

/** One changed row of the diff: a deleted line, an added line, or a deleted and an added line paired. */
export interface ReviewAtom {
  oldLine: number | null;
  newLine: number | null;
  /** Structures owning the row's lines; two or more make it a shared row. */
  owners: string[];
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
      atoms.push({ oldLine: row.oldLine, newLine: row.newLine, owners: [] });
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

  const oldOwners = paintOwners(input.oldDeclarations);
  const newOwners = paintOwners(input.newDeclarations);
  let partial = input.recovered;
  for (const atom of atoms) {
    const owners = new Set<string>();
    if (atom.oldLine !== null) for (const key of oldOwners.get(atom.oldLine) ?? [OTHER_STRUCTURE_ID]) owners.add(key);
    if (atom.newLine !== null) for (const key of newOwners.get(atom.newLine) ?? [OTHER_STRUCTURE_ID]) owners.add(key);
    atom.owners = [...owners];
  }
  adoptBlankLines(atoms, atomTexts, blockOfAtom);

  const merged = mergeDeclarations(input.oldDeclarations, input.newDeclarations);
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
    structures.push({
      id: entry.key,
      kind: entry.kind,
      name: entry.name,
      parentId: entry.parentKey,
      depth: entry.depth,
      status: entry.old && entry.new ? "modified" : entry.new ? (entry.ambiguous ? "modified" : "added") : (entry.ambiguous ? "modified" : "removed"),
      facts: reliable ? describe(entry, own, members, atoms) : [],
      atoms: own,
      sharedAtoms: own.filter((index) => (atoms[index]?.owners.length ?? 0) > 1),
      memberAtoms: members,
      reliable,
      anchor: anchorOf(entry, own.length ? own : members, atoms),
      fingerprint: fingerprint(own.map((index) => atomTexts[index] ?? "")),
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

  return {
    status: "ready",
    analysis: { revision: hunksDocument?.revision ?? fullDocument.revision, structures, atoms, rowAtoms, partial },
  };
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
    if (only && only !== OTHER_STRUCTURE_ID) atom.owners = [only];
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
      ambiguous: declaration.key.includes("#"),
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

function describe(entry: MergedDeclaration, own: number[], members: number[], atoms: ReviewAtom[]): ChangeFact[] {
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
  // A line holding both the signature and the body's opening brace counts as signature.
  const bodyAtom = hasBody ? ownAtoms.find((atom) => inBody(atom) && !inSignature(atom)) : undefined;
  // Header lines outside the parameter list and return type: modifiers, decorators, comments, or the whole declaration.
  const declarationAtom = ownAtoms.find((atom) => !(hasBody && inBody(atom)) && !inSignature(atom));
  const ownChange = OWN_CHANGE_FACT[entry.kind] ?? "declaration";
  if (declarationAtom) facts.push({ kind: ownChange, at: atomLine(declarationAtom) });
  if (bodyAtom) facts.push({ kind: "body", at: atomLine(bodyAtom) });
  // A one-line function whose signature text is unchanged: the change is in its body.
  const first = ownAtoms[0];
  if (facts.length === 0 && first) facts.push({ kind: hasBody && ownAtoms.some(inBody) ? "body" : ownChange, at: atomLine(first) });
  facts.push(...memberFact);
  return facts;
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
 * The row selections that stage a structure's changes. Shared rows are `withheld`; `touched` also
 * lists them, for clearing everything the structure changes.
 */
export function structureSelection(analysis: CodeReviewAnalysis, id: string, includeMembers: boolean): { rows: RowSelection[]; touched: RowSelection[]; withheld: number } {
  const ids = new Set([id]);
  if (includeMembers) {
    // Structures are listed parents first, so one pass collects every descendant.
    for (const structure of analysis.structures) {
      if (structure.parentId && ids.has(structure.parentId)) ids.add(structure.id);
    }
  }
  const rows: RowSelection[] = [];
  const touched: RowSelection[] = [];
  let withheld = 0;
  for (const atom of analysis.atoms) {
    if (!atom.owners.some((owner) => ids.has(owner))) continue;
    if (atom.selection) touched.push(atom.selection);
    // A shared row also changes another structure; it is only taken when every owner is being selected.
    if (!atom.owners.every((owner) => ids.has(owner))) {
      withheld += 1;
      continue;
    }
    if (atom.selection) rows.push(atom.selection);
  }
  return { rows, touched, withheld };
}
