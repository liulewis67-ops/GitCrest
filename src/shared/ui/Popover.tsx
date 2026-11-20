import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMenuPlacement } from "../hooks/use-menu-placement";
import { endComposition, guardImeKey, startComposition } from "../lib/ime-guard";

/** A non-modal control group outside clipped content, with nested pickers kept inside it. */
export function Popover({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useMenuPlacement(panel, trigger, open);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("select, button, input")?.focus();
    const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
    const outside = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const host = trigger.current?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body;
  return <>
    <button ref={trigger} type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>{label}</button>
    {open && createPortal(<div ref={panel} id={id} role="group" aria-label={label} data-popover-root className={className}
      onCompositionStartCapture={startComposition} onCompositionEndCapture={endComposition} onKeyDown={(event) => {
        if (guardImeKey(event)) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
        if (event.key === "Tab") {
          const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('select, button, input, [tabindex]') ?? []).filter(node => !node.matches(':disabled') && node.tabIndex >= 0 && node.getClientRects().length > 0);
          if ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls[controls.length - 1])) {
            event.preventDefault();
            event.stopPropagation();
            const pageControls = Array.from(document.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')).filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert], [hidden]') && !panel.current?.contains(node) && node.getClientRects().length > 0);
            const next = event.shiftKey ? trigger.current : pageControls[pageControls.indexOf(trigger.current!) + 1];
            setOpen(false);
            next?.focus();
          }
        }
      }}>{children}</div>, host)}
  </>;
}
