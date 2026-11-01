import { useLayoutEffect, type KeyboardEvent, type RefObject } from "react";

/** Anchor menus to their trigger, flipping above it when space below runs out. */
export function useMenuPlacement(menuRef: RefObject<HTMLElement>, triggerRef: RefObject<HTMLElement>, open: boolean, align: "start" | "end" = "start") {
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!open || !menu || !trigger) return;
    const place = () => {
      menu.style.position = "fixed";
      menu.style.maxHeight = "calc(100dvh - 16px)";
      menu.style.overflowY = "auto";
      const anchor = trigger.getBoundingClientRect();
      const { width, height } = menu.getBoundingClientRect();
      const left = align === "end" ? anchor.right - width : anchor.left;
      const below = anchor.bottom + 4;
      const top = below + height <= window.innerHeight - 8 ? below : anchor.top - height - 4;
      menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.right = "auto";
      menu.style.bottom = "auto";
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [open, align, menuRef, triggerRef]);
}

/** Shared keyboard movement for action and radio menus; disabled choices are skipped. */
export function navigateMenu(event: KeyboardEvent<HTMLElement>, closeAndRestoreFocus: () => void) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)")];
  const index = items.indexOf(document.activeElement as HTMLElement);
  const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
  const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
  const target = forward ? items[(index + 1) % items.length]
    : backward ? items[(index - 1 + items.length) % items.length]
      : event.key === "Home" ? items[0] : event.key === "End" ? items[items.length - 1] : undefined;
  if (target) {
    event.preventDefault();
    target.focus();
    target.scrollIntoView?.({ block: "nearest" });
  } else if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    closeAndRestoreFocus();
    if (event.key === "Tab") {
      const trigger = document.activeElement;
      const menu = event.currentTarget;
      const direction = event.shiftKey ? -1 : 1;
      queueMicrotask(() => {
        const controls = [...document.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]")].filter((element) => element.tabIndex >= 0 && !menu.contains(element) && !element.closest("[inert], [hidden], [aria-hidden='true']") && element.getClientRects().length > 0);
        const index = controls.indexOf(trigger as HTMLElement);
        if (index >= 0) controls[index + direction]?.focus();
      });
    }
  }
}
