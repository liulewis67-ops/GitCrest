import { useCallback, useEffect, useReducer } from "react";
import type { ReviewStructure } from "./code-review-analysis";

// Review marks live only in this window, so they are never mistaken for a pull-request review.
const reviewed = new Set<string>();
const listeners = new Set<() => void>();

function markKey(fileKey: string, structure: ReviewStructure): string {
  return `${fileKey}\u0000${structure.id}\u0000${structure.fingerprint}`;
}

/**
 * Structures the user marked as reviewed in one file. A mark holds only while the structure's changed
 * lines are exactly the same, so any further edit to it clears the mark. Marking never stages anything.
 */
export function useReviewedStructures(fileKey: string) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    return () => { listeners.delete(rerender); };
  }, []);
  const isReviewed = useCallback((structure: ReviewStructure) => reviewed.has(markKey(fileKey, structure)), [fileKey]);
  const toggleReviewed = useCallback((structure: ReviewStructure) => {
    const key = markKey(fileKey, structure);
    if (reviewed.has(key)) reviewed.delete(key);
    else reviewed.add(key);
    for (const listener of listeners) listener();
  }, [fileKey]);
  return { isReviewed, toggleReviewed };
}
