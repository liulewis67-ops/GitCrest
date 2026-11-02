import { navigateMenu } from "../hooks/use-menu-placement";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ContextMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Why the item is disabled, or what it will do. */
  title?: string;
  danger?: boolean;
  icon?: ReactNode;
  /** Draws a divider above the item to separate groups of actions. */
  separatorBefore?: boolean;
};

const VIEWPORT_MARGIN = 6;

/**
 * A right-click menu opened at a point, such as the pointer. It stays inside the window, takes keyboard focus, and
 * closes on a choice, Escape, a click elsewhere, scrolling or resizing; focus then returns to `returnFocusTo`.
 */
export function ContextMenu({ x, y, label, items, returnFocusTo, onClose }: {
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [position, setPosition] = useState({ left: x, top: y, ready: false });

  // Measure once rendered, then flip or shift so the whole menu fits in the window.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    const left = x > maxLeft ? Math.max(VIEWPORT_MARGIN, x - width) : x;
    const top = y > maxTop ? Math.max(VIEWPORT_MARGIN, Math.min(y - height, maxTop)) : y;
    setPosition({ left, top, ready: true });
  }, [x, y]);

  // A right-click elsewhere closes this menu on mousedown, before its contextmenu event can open the next one.
  useEffect(() => {
    // Focusing or revealing the trigger can queue a scroll event before this menu mounts.
    // Only a new scroll should dismiss it; the queued event may arrive after its first item takes focus.
    const scrollPositions = new Map<HTMLElement, { top: number; left: number }>();
    for (let node = returnFocusTo?.parentElement; node; node = node.parentElement) {
      scrollPositions.set(node, { top: node.scrollTop, left: node.scrollLeft });
    }
    const dismiss = () => onCloseRef.current();
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      const target = event.target;
      const previous = target instanceof HTMLElement ? scrollPositions.get(target) : undefined;
      if (previous && target instanceof HTMLElement && previous.top === target.scrollTop && previous.left === target.scrollLeft) return;
      dismiss();
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  // The menu is hidden until placed, and a hidden button cannot take focus.
  useEffect(() => {
    if (position.ready) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [position.ready]);

  function closeAndRestoreFocus() {
    onClose();
    returnFocusTo?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) { navigateMenu(event, closeAndRestoreFocus); }

  return createPortal(
    <div
      ref={menuRef}
      className="actionMenu contextMenu"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => <div className={item.separatorBefore || (index > 0 && Boolean(item.danger) !== Boolean(items[index - 1].danger)) ? "actionMenuGroup separated" : "actionMenuGroup"} key={item.id} role="none">
        <button type="button" role="menuitem" className={item.danger ? "danger" : undefined} disabled={item.disabled} title={item.title} onClick={() => { closeAndRestoreFocus(); item.onSelect(); }}>
          <span className="contextMenuIcon" aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      </div>)}
    </div>,
    document.body,
  );
}
