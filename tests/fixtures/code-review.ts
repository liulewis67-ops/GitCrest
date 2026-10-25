import { readFile } from "node:fs/promises";
import { Language, Parser } from "@willbooster/web-tree-sitter";
import type { DiffDocumentResponse } from "../../src/api/client";
import { analyzeCodeReview, structureSelection, type CodeReviewAnalysis } from "../../src/features/diff/model/code-review-analysis";
import type { LanguageSyntax } from "../../src/features/languages/model/builtin-languages";
import type { SourceDeclaration, SyntaxNodeLike } from "../../src/features/languages/model/structure-common";

type Row = DiffDocumentResponse["hunks"][number]["rows"][number];

let runtime: Promise<void> | undefined;
const grammars = new Map<string, Promise<Language>>();

/** Loads a grammar's .wasm from node_modules with the project's tree-sitter runtime. */
export async function loadTestGrammar(path: string): Promise<Language> {
  runtime ??= Parser.init();
  await runtime;
  let grammar = grammars.get(path);
  if (!grammar) {
    grammar = readFile(path).then((bytes) => Language.load(new Uint8Array(bytes)));
    grammars.set(path, grammar);
  }
  return grammar;
}

export async function parseWith(path: string, source: string, read: (root: SyntaxNodeLike) => SourceDeclaration[]) {
  const language = await loadTestGrammar(path);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    return { declarations: read(tree.rootNode), hasError: tree.rootNode.hasError };
  } finally {
    tree.delete();
    parser.delete();
  }
}

/** Line diff shaped like the core's parser: deletions and additions of one block are paired row by row. */
export function diffRows(before: string, after: string): Row[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const rows: Row[] = [];
  let deleted: Array<[number, string]> = [];
  let added: Array<[number, string]> = [];
  const flush = () => {
    for (let index = 0; index < Math.max(deleted.length, added.length); index += 1) {
      rows.push({ kind: "change", oldLine: deleted[index]?.[0] ?? null, newLine: added[index]?.[0] ?? null, oldText: deleted[index]?.[1] ?? null, newText: added[index]?.[1] ?? null });
    }
    deleted = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      rows.push({ kind: "context", oldLine: i + 1, newLine: j + 1, oldText: a[i]!, newText: b[j]! });
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      added.push([j + 1, b[j]!]);
      j += 1;
    } else {
      deleted.push([i + 1, a[i]!]);
      i += 1;
    }
  }
  flush();
  return rows;
}

/** A full-file document and a hunk document (three lines of context) for the same change. */
export function diffDocuments(path: string, before: string, after: string): { full: DiffDocumentResponse; hunks: DiffDocumentResponse } {
  const rows = diffRows(before, after);
  const base = { repoId: "repo_fixture", path, originalPath: null, scope: "workingTree" as const, changeKind: "modified" as const, status: "text" as const };
  const full = { ...base, revision: "sha256:full", hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, rows }] };
  const keep = rows.map(() => false);
  rows.forEach((row, index) => {
    if (row.kind !== "change") return;
    for (let near = Math.max(0, index - 3); near <= Math.min(rows.length - 1, index + 3); near += 1) keep[near] = true;
  });
  const hunks: DiffDocumentResponse["hunks"] = [];
  let current: Row[] = [];
  rows.forEach((row, index) => {
    if (keep[index]) current.push(row);
    else if (current.length) {
      hunks.push({ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, rows: current });
      current = [];
    }
  });
  if (current.length) hunks.push({ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, rows: current });
  return { full, hunks: { ...base, revision: "sha256:hunks", hunks } };
}

/** Runs the whole analysis on two versions of a file whose declarations `read` returns. */
export async function analyzeSources(
  path: string,
  before: string,
  after: string,
  read: (source: string) => Promise<{ declarations: SourceDeclaration[]; hasError: boolean }>,
  syntax?: LanguageSyntax,
): Promise<{ analysis: CodeReviewAnalysis; hunks: DiffDocumentResponse }> {
  const { full, hunks } = diffDocuments(path, before, after);
  const old = await read(before);
  const modified = await read(after);
  const result = analyzeCodeReview({ fullDocument: full, hunksDocument: hunks, oldDeclarations: old.declarations, newDeclarations: modified.declarations, recovered: old.hasError || modified.hasError, syntax });
  if (result.status !== "ready") throw new Error("analysis is stale");
  return { analysis: result.analysis, hunks };
}

export function structureOf(analysis: CodeReviewAnalysis, id: string) {
  const found = analysis.structures.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing ${id}; have ${analysis.structures.map((candidate) => candidate.id).join(", ")}`);
  return found;
}

export function factsOf(analysis: CodeReviewAnalysis, id: string): string[] {
  return structureOf(analysis, id).facts.map((fact) => fact.kind);
}

/** The rows a structure selection would stage, as `old → new` text. */
export function selectedRowTexts(analysis: CodeReviewAnalysis, hunks: DiffDocumentResponse, id: string, includeMembers = false): string[] {
  return structureSelection(analysis, id, includeMembers).rows.map(({ hunkIndex, rowIndex }) => {
    const row = hunks.hunks[hunkIndex]!.rows[rowIndex]!;
    return `${row.oldText ?? "∅"} → ${row.newText ?? "∅"}`;
  });
}
