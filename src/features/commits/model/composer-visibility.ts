/**
 * Whether the commit form is shown at the bottom of the Commit panel. It belongs to the Changes
 * view only, and only while the working tree has something to commit or the draft holds text,
 * so a half-written message never disappears from view.
 */
export function isComposerVisible({ inChangesView, statusReady, stagedCount, workingCount, draft, amend }: {
  inChangesView: boolean;
  statusReady: boolean;
  stagedCount: number;
  workingCount: number;
  /** Summary and description text. */
  draft: string;
  amend: boolean;
}): boolean {
  return inChangesView && statusReady && (stagedCount > 0 || workingCount > 0 || draft.trim().length > 0 || amend);
}
