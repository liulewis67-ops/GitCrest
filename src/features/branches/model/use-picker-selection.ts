import { useState } from "react";

/** Checkbox selection is independent from the row action (opening or switching). */
export function usePickerSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  function toggle(id: string, visible: string[], range = false) {
    const first = anchor ? visible.indexOf(anchor) : -1;
    const last = visible.indexOf(id);
    const ids = range && first >= 0 && last >= 0 ? visible.slice(Math.min(first, last), Math.max(first, last) + 1) : [id];
    setSelected(previous => {
      const next = new Set(previous);
      for (const item of ids) {
        if (previous.has(id)) next.delete(item);
        else next.add(item);
      }
      return next;
    });
    setAnchor(id);
  }
  return { selected, toggle, clear: () => { setSelected(new Set()); setAnchor(undefined); }, select: (ids: string[]) => setSelected(new Set(ids)) };
}
