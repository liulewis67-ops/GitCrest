import { useMenuPlacement, navigateMenu } from "../../../shared/hooks/use-menu-placement";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../shared/i18n";

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
  const { t } = useI18n();
  const [position, setPosition] = useState<{ top: number; right: number }>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = Boolean(position);
  useMenuPlacement(menuRef, buttonRef, open, "end");

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
    const onScroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("scroll", onScroll, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", onScroll, true);
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
    <button ref={buttonRef} className="branchAction" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={t("br.moreActionsFor", { branch })} title={t("br.moreActions")} disabled={disabled} onClick={toggle}>⋯</button>
    {position && <div ref={menuRef} onKeyDown={(event) => navigateMenu(event, () => { setPosition(undefined); buttonRef.current?.focus(); })} className="branchRowMenu" role="menu" aria-label={t("br.actionsFor", { branch })} style={{ top: position.top, right: position.right }}>
      <button type="button" role="menuitem" aria-label={t("br.openNewWorktreeAria", { branch })} disabled={Boolean(checkedOutAt)} title={checkedOutAt ? t("br.alreadyCheckedOut", { path: checkedOutAt }) : undefined} onClick={choose(onNewWorktree)}>{t("br.openNewWorktree")}</button>
      <button type="button" role="menuitem" aria-label={t("br.renameAria", { branch })} onClick={choose(onRename)}>{t("br.rename")}</button>
      <button type="button" role="menuitem" className="danger separated" aria-label={t("br.deleteAria", { branch })} disabled={Boolean(checkedOutAt)} title={checkedOutAt ? t("br.removeWorktreeFirst") : undefined} onClick={choose(onDelete)}>{t("br.delete")}</button>
    </div>}
  </>;
}
