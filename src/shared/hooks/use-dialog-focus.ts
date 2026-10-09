import { useEffect, useRef, type KeyboardEvent } from "react";

const focusableSelector = "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function useDialogFocus<T extends HTMLElement>(onEscape?: () => void, closeBlocked = false, returnFocus?: () => HTMLElement | null, active = true) {
  const dialogRef = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);
  const closeBlockedRef = useRef(closeBlocked);
  const returnFocusRef = useRef(returnFocus);
  onEscapeRef.current = onEscape;
  closeBlockedRef.current = closeBlocked;
  returnFocusRef.current = returnFocus;

  useEffect(() => {
    if (!active) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    const preferred = dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]");
    const autofocus = dialog?.querySelector<HTMLElement>("[autofocus]");
    const firstFocusable = dialog?.querySelector<HTMLElement>(focusableSelector);
    const initialTarget = preferred && !preferred.matches(":disabled")
      ? preferred
      : autofocus && !autofocus.matches(":disabled") ? autofocus : firstFocusable;
    if (initialTarget) initialTarget.focus();
    else if (dialog) {
      dialog.tabIndex = -1;
      dialog.focus();
    }
    return () => {
      const target = returnFocusRef.current?.() ?? previousFocus;
      if (target?.isConnected) target.focus();
    };
  }, [active]);

  function onKeyDown(event: KeyboardEvent<T>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!closeBlockedRef.current && onEscapeRef.current) {
        onEscapeRef.current();
      }
      return;
    }
    if (event.key !== "Tab") return;
    event.stopPropagation();

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) =>
      !element.matches(":disabled")
      && element.tabIndex >= 0
      && !element.closest("[hidden], [aria-hidden='true']"),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      event.stopPropagation();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      event.stopPropagation();
      first.focus();
    }
  }

  return { dialogRef, onKeyDown };
}
