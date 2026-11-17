import { useMenuPlacement, navigateMenu } from "../../shared/hooks/use-menu-placement";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n } from "../../shared/i18n";

const MENU_WIDTH = 280;

/** The "+" at the end of the repository tabs: open, clone or initialize a repository without going back to Welcome. */
export function NewRepositoryTabMenu({ connected, openingRepository, shortcuts, isMacPlatform, onOpenLocalRepository, onCloneRepository, onInitializeRepository }: {
  connected: boolean;
  openingRepository: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  onOpenLocalRepository: () => void;
  onCloneRepository: () => void;
  onInitializeRepository: () => void;
}) {
  const { t } = useI18n();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = Boolean(position);
  useMenuPlacement(menuRef, buttonRef, open, "start");

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
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setPosition(undefined);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, left: Math.max(4, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 4)) });
  };
  const choose = (action: () => void) => () => {
    setPosition(undefined);
    action();
  };
  const items = [
    { id: "open", label: t("welcome.openLocal"), hint: t("welcome.openLocalHint"), shortcut: shortcuts.openRepository, disabled: openingRepository, run: onOpenLocalRepository },
    { id: "clone", label: t("welcome.cloneAction"), hint: t("welcome.cloneHint"), shortcut: shortcuts.cloneRepository, disabled: !connected, run: onCloneRepository },
    { id: "init", label: t("welcome.init"), hint: t("welcome.initHint"), shortcut: shortcuts.initializeRepository, disabled: false, run: onInitializeRepository },
  ];

  return <>
    <button ref={buttonRef} className="newRepositoryTab" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={t("titlebar.newTab")} title={t("titlebar.newTab")} onClick={toggle}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
    </button>
    {position && createPortal(<div ref={menuRef} onKeyDown={(event) => navigateMenu(event, () => { setPosition(undefined); buttonRef.current?.focus(); })} className="newRepositoryTabMenu" role="menu" aria-label={t("titlebar.newTab")} style={{ top: position.top, left: position.left, width: MENU_WIDTH }}>
      {items.map((item) => (
        <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={choose(item.run)}>
          <span className="newRepositoryTabMenuText"><strong>{item.label}</strong><span>{item.hint}</span></span>
          <kbd>{displayShortcut(item.shortcut, isMacPlatform)}</kbd>
        </button>
      ))}
    </div>, document.body)}
  </>;
}
