import { rowKey, type CodeReviewAnalysis, type ReviewAtom, type RowSelection } from "./code-review-analysis";
import { rowState } from "./row-selection";

/** A name the selected rows use that only an unselected change brings into the file. */
export interface DependencyHint {
  name: string;
  /** The rows that bring the name in, as they would be selected. */
  rows: RowSelection[];
}

const MAX_HINTS = 5;

function newSideSelected(keys: ReadonlySet<string>, atom: ReviewAtom): boolean {
  if (!atom.selection || atom.newLine === null) return false;
  const state = rowState(keys, atom.selection.hunkIndex, atom.selection.rowIndex);
  return state === "all" || state === "new";
}

/** The part of an atom's row that adds its new line. */
function addingPart(atom: ReviewAtom): RowSelection | undefined {
  if (!atom.selection) return undefined;
  return atom.oldLine !== null ? { ...atom.selection, side: "new" } : atom.selection;
}

/**
 * Names the selection uses but would leave undefined in the staged file: a selected line mentions a
 * name new to the file, and every line that brings it in (an import, or an added declaration) is
 * unselected. Same-file and name-based only, so it is a hint, never a block.
 */
export function dependencyHints(analysis: CodeReviewAnalysis, keys: ReadonlySet<string>): DependencyHint[] {
  const hints: DependencyHint[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const [hunkIndex, rowIndex] = key.split(":");
    const atomIndex = analysis.rowAtoms.get(rowKey(Number(hunkIndex), Number(rowIndex)));
    const atom = atomIndex === undefined ? undefined : analysis.atoms[atomIndex];
    if (!atom || !newSideSelected(keys, atom)) continue;
    for (const name of atom.introduces) {
      if (seen.has(name)) continue;
      const definers = (analysis.definers.get(name) ?? []).filter((index) => index !== atomIndex);
      if (definers.length === 0 || (atomIndex !== undefined && analysis.definers.get(name)?.includes(atomIndex))) continue;
      const atoms = definers.map((index) => analysis.atoms[index]).filter((candidate): candidate is ReviewAtom => candidate !== undefined);
      if (atoms.some((candidate) => newSideSelected(keys, candidate))) continue;
      const rows = atoms.map(addingPart).filter((row): row is RowSelection => row !== undefined);
      if (rows.length === 0) continue;
      seen.add(name);
      hints.push({ name, rows });
      if (hints.length === MAX_HINTS) return hints;
    }
  }
  return hints;
}

/** Selected added lines that look like debug output, as the parts to deselect. */
export function selectedDebugRows(analysis: CodeReviewAnalysis, keys: ReadonlySet<string>): RowSelection[] {
  return analysis.debugAtoms
    .map((index) => analysis.atoms[index])
    .filter((atom): atom is ReviewAtom => atom !== undefined && newSideSelected(keys, atom))
    .map(addingPart)
    .filter((row): row is RowSelection => row !== undefined);
}
