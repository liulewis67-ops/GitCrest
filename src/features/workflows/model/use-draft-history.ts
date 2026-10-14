import { useCallback, useRef, useState } from "react";

const HISTORY_LIMIT = 50;

/** Undo/redo for programmatic draft changes (gutter actions, bulk apply) that the textarea's native undo cannot see. */
export function useDraftHistory() {
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const [, bump] = useState(0);

  const record = useCallback((previous: string) => {
    past.current = [...past.current.slice(-(HISTORY_LIMIT - 1)), previous];
    future.current = [];
    bump((value) => value + 1);
  }, []);
  const undo = useCallback((current: string) => {
    const previous = past.current[past.current.length - 1];
    if (previous === undefined) return undefined;
    past.current = past.current.slice(0, -1);
    future.current = [...future.current, current];
    bump((value) => value + 1);
    return previous;
  }, []);
  const redo = useCallback((current: string) => {
    const next = future.current[future.current.length - 1];
    if (next === undefined) return undefined;
    future.current = future.current.slice(0, -1);
    past.current = [...past.current, current];
    bump((value) => value + 1);
    return next;
  }, []);
  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    bump((value) => value + 1);
  }, []);

  return { record, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
