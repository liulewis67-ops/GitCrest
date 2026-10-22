/**
 * Whether the commit composer is on screen, and how much of it. It belongs to the Changes view
 * only, and only while the working tree has something to commit or the draft holds text.
 * Collapsed it is one row (summary and Commit); it expands with staged changes or a draft.
 */
export function getComposerVisibility({ inChangesView, statusReady, stagedCount, workingCount, draft, amend, assistantOpen, selectionCount, expandedOverride }: {
  inChangesView: boolean;
  statusReady: boolean;
  stagedCount: number;
  workingCount: number;
  /** Summary and description text. */
  draft: string;
  amend: boolean;
  assistantOpen: boolean;
  selectionCount: number;
  /** The user's own expand or collapse choice, if any. */
  expandedOverride?: boolean;
}): { visible: boolean; expanded: boolean } {
  const hasDraft = draft.trim().length > 0;
  const visible = inChangesView && statusReady && (stagedCount > 0 || workingCount > 0 || hasDraft || amend);
  if (!visible) return { visible: false, expanded: false };
  // Open tools and pending choices must stay visible, whatever the user last chose.
  if (assistantOpen || amend || selectionCount > 0) return { visible, expanded: true };
  return { visible, expanded: expandedOverride ?? (stagedCount > 0 || hasDraft) };
}
