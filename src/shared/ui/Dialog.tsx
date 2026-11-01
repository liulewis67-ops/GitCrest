import { createContext, useContext, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { useI18n } from "../i18n";
import { Button } from "./Button";
import { Icon } from "./Icon";

const DialogContext = createContext<{ onClose: () => void; busy: boolean; closeLabel?: string } | undefined>(undefined);

type DialogProps = Omit<HTMLAttributes<HTMLElement>, "onClose"> & {
  onClose: () => void;
  busy?: boolean;
  closeLabel?: string;
  returnFocus?: () => HTMLElement | null;
  backdropClassName?: string;
  inline?: boolean;
  fullPage?: boolean;
  children: ReactNode;
};

/** One modal lifecycle: Escape, focus trap, initial focus and return to the opener. */
export function Dialog({ onClose, busy = false, closeLabel, returnFocus, backdropClassName = "", inline = false, fullPage = false, className = "", onKeyDown, children, ...props }: DialogProps) {
  // Capture before background isolation can blur the opener in a full-page dialog.
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const { dialogRef, onKeyDown: handleDialogKeyDown } = useDialogFocus<HTMLElement>(onClose, busy, () => returnFocus?.() ?? opener.current);
  useLayoutEffect(() => {
    if (!fullPage) return;
    const node = dialogRef.current;
    if (!node?.parentElement) return;
    const parent = node.parentElement;
    const original = new Map<HTMLElement, boolean>();
    const isolate = () => {
      for (const element of parent.children) {
        if (!(element instanceof HTMLElement) || element === node) continue;
        if (!original.has(element)) original.set(element, element.inert);
        element.inert = true;
      }
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(parent, { childList: true });
    return () => {
      observer.disconnect();
      original.forEach((inert, element) => { element.inert = inert; });
    };
  }, [fullPage, dialogRef]);
  const panel = <section {...props} ref={dialogRef} className={`sharedDialog${fullPage ? " sharedDialogFullPage" : ""}${inline ? " sharedDialogInline" : ""} ${className}`.trim()} role={props.role || "dialog"} aria-modal={inline ? undefined : true} onKeyDown={(event) => { handleDialogKeyDown(event); if (!event.defaultPrevented) onKeyDown?.(event); }}>{children}</section>;
  return <DialogContext.Provider value={{ onClose, busy, closeLabel }}>{inline || fullPage ? panel : <div className={`paletteBackdrop sharedDialogBackdrop ${backdropClassName}`.trim()} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>{panel}</div>}</DialogContext.Provider>;
}

export function DialogHeader({ children, className = "", ...props }: HTMLAttributes<HTMLElement>) {
  const context = useContext(DialogContext);
  const { t } = useI18n();
  if (!context) throw new Error("DialogHeader requires Dialog");
  return <header {...props} className={`sharedDialogHeader ${className}`.trim()}>
    {children}
    <Button className="sharedDialogClose" variant="quiet" size="compact" disabled={context.busy} aria-label={context.closeLabel || t("common.close")} onClick={context.onClose} data-dialog-close>
      <Icon name="close" />
    </Button>
  </header>;
}

export function DialogFooter({ children, className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <footer {...props} className={`sharedDialogFooter ${className}`.trim()}>{children}</footer>;
}
