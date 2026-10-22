import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type MenuButtonItem = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Why the item is disabled, or what it will do. */
  title?: string;
  danger?: boolean;
  /** Draws a divider above the item to separate groups of actions. */
  separatorBefore?: boolean;
};

/** A compact button that opens a keyboard-navigable action menu below it. */
export function MenuButton({ label, title, menuLabel, className, children, disabled, items }: {
  label: string;
  title?: string;
  menuLabel: string;
  className?: string;
  children: ReactNode;
  disabled?: boolean;
  items: MenuButtonItem[];
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
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setPosition(undefined);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, right: Math.max(4, window.innerWidth - rect.right) });
  }

  function closeAndRestoreFocus() {
    setPosition(undefined);
    buttonRef.current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const target = event.key === "ArrowDown" ? enabled[(index + 1) % enabled.length]
      : event.key === "ArrowUp" ? enabled[(index - 1 + enabled.length) % enabled.length]
        : event.key === "Home" ? enabled[0]
          : event.key === "End" ? enabled[enabled.length - 1] : undefined;
    if (target) {
      event.preventDefault();
      target.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
    } else if (event.key === "Tab") {
      setPosition(undefined);
    }
  }

  return <>
    <button ref={buttonRef} className={className} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={title ?? label} disabled={disabled} onClick={toggle}>{children}</button>
    {position && <div ref={menuRef} className="actionMenu" role="menu" aria-label={menuLabel} style={{ top: position.top, right: position.right }} onKeyDown={onMenuKeyDown}>
      {items.map((item) => <div className={item.separatorBefore ? "actionMenuGroup separated" : "actionMenuGroup"} key={item.id} role="none">
        <button type="button" role="menuitem" className={item.danger ? "danger" : undefined} disabled={item.disabled} title={item.title} onClick={() => { closeAndRestoreFocus(); item.onSelect(); }}>{item.label}</button>
      </div>)}
    </div>}
  </>;
}
