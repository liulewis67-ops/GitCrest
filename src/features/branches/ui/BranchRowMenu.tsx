import { useEffect, useRef, useState } from "react";

/** The less common actions for a local branch row, behind one compact button so the branch name keeps its room. */
export function BranchRowMenu({ branch, disabled, checkedOutAt, onNewWorktree, onRename, onDelete }: {
  branch: string;
  disabled: boolean;
  /** Folder of another worktree that already has this branch checked out. */
  checkedOutAt?: string;
  onNewWorktree: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [position, setPosition] = useState<{ top: number; right: number }>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = Boolean(position);

  useEffect(() => {
    if (!open) return;
    const close = () => setPosition(undefined);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setPosition(undefined);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 2, right: Math.max(4, window.innerWidth - rect.right) });
  };
  const choose = (action: () => void) => () => {
    setPosition(undefined);
    action();
  };

  return <>
    <button ref={buttonRef} className="branchAction" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`More actions for ${branch}`} title="More actions" disabled={disabled} onClick={toggle}>⋯</button>
    {position && <div ref={menuRef} className="branchRowMenu" role="menu" aria-label={`Actions for ${branch}`} style={{ top: position.top, right: position.right }}>
      <button type="button" role="menuitem" aria-label={`Open ${branch} in a new worktree`} disabled={Boolean(checkedOutAt)} title={checkedOutAt ? `Already checked out in ${checkedOutAt}` : undefined} onClick={choose(onNewWorktree)}>Open in new worktree…</button>
      <button type="button" role="menuitem" aria-label={`Rename ${branch}`} onClick={choose(onRename)}>Rename…</button>
      <button type="button" role="menuitem" className="danger" aria-label={`Delete ${branch}`} disabled={Boolean(checkedOutAt)} title={checkedOutAt ? "Remove the worktree that has this branch checked out first" : undefined} onClick={choose(onDelete)}>Delete…</button>
    </div>}
  </>;
}
