import { startComposition, endComposition, guardImeKey } from "../lib/ime-guard";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { useMenuPlacement } from "../hooks/use-menu-placement";
import { Icon } from "./Icon";

type Choice = { value: string; label: string; disabled: boolean; group: string };

/** Keeps native form values, labels and styling, with a searchable popup for every choice list. */
export function SearchableSelect({ children, onKeyDown, onMouseDown, onClick, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const { t } = useI18n();
  const id = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [active, setActive] = useState(0);
  const filtered = choices.filter((choice) => `${choice.label} ${choice.value} ${choice.group}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const enabled = filtered.filter((choice) => !choice.disabled);
  const current = enabled[Math.min(active, Math.max(0, enabled.length - 1))];
  useMenuPlacement(popupRef, selectRef, open);

  useLayoutEffect(() => {
    if (!open || !selectRef.current) return;
    setChoices(Array.from(selectRef.current.options, (option) => ({
      value: option.value, label: option.label,
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : "",
    })));
  }, [open, children]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const outside = (event: MouseEvent) => {
      if (!popupRef.current?.contains(event.target as Node) && event.target !== selectRef.current) setOpen(false);
    };
    const close = () => setOpen(false);
    const scroll = (event: Event) => { if (!popupRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);
  useEffect(() => {
    if (current) document.getElementById(`${id}-option-${choices.indexOf(current)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, id, choices]);

  function show(initialQuery = "") {
    if (props.disabled) return;
    setQuery(initialQuery);
    setActive(0);
    setOpen(true);
  }
  function close() { setOpen(false); selectRef.current?.focus(); }
  function choose(choice: Choice) {
    const select = selectRef.current;
    if (!select || props.disabled || choice.disabled) return;
    select.value = choice.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  }
  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (guardImeKey(event)) return;
    event.stopPropagation();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % Math.max(1, enabled.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (current) choose(current);
    } else if (event.key === "Escape") {
      event.preventDefault(); close();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const select = selectRef.current;
      const scope = select?.closest('[role="dialog"], [role="alertdialog"]') ?? document;
      const controls = Array.from(scope.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !popupRef.current?.contains(element) && !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0);
      const index = controls.indexOf(select!);
      const next = index + (event.shiftKey ? -1 : 1);
      close();
      const target = scope === document ? controls[next] : controls[(next + controls.length) % controls.length];
      target?.focus();
    }
  }

  const host = selectRef.current?.closest('[data-popover-root], [role="dialog"], [role="alertdialog"]') ?? document.body;
  return <>
    <select {...props} ref={selectRef} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? `${id}-list` : undefined}
      onMouseDown={(event) => { onMouseDown?.(event); if (!event.defaultPrevented && event.button === 0) { event.preventDefault(); selectRef.current?.focus(); } }}
      onClick={(event) => { onClick?.(event); if (!event.defaultPrevented) { event.preventDefault(); if (open) close(); else show(); } }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); show(); }
        else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); show(event.key); }
      }}>{children}</select>
    {open && !props.disabled && createPortal(<div ref={popupRef} className="searchableSelectPopup" style={{ width: Math.max(220, selectRef.current?.getBoundingClientRect().width ?? 0) }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <div className="searchableSelectSearch"><Icon name="search" /><input ref={searchRef} onCompositionStart={startComposition} onCompositionEnd={endComposition} type="search" role="combobox" aria-label={t("select.search")} placeholder={t("select.search")} aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={current ? `${id}-option-${choices.indexOf(current)}` : undefined} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onSearchKeyDown} /></div>
      <div id={`${id}-list`} role="listbox" aria-label={props["aria-label"] ?? t("select.options")} className="searchableSelectOptions">
        {filtered.map((choice) => <div key={`${choice.value}-${choices.indexOf(choice)}`} id={`${id}-option-${choices.indexOf(choice)}`} role="option" aria-selected={selectRef.current?.value === choice.value} aria-disabled={choice.disabled || undefined} className={`searchableSelectOption${current === choice ? " active" : ""}`} title={choice.label} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(choice)}>
          <span>{choice.group && <small>{choice.group} / </small>}{choice.label}</span>{selectRef.current?.value === choice.value && <Icon name="check" />}
        </div>)}
        {filtered.length === 0 && <p className="searchableSelectEmpty" role="status">{t("select.noResults")}</p>}
      </div>
    </div>, host)}
  </>;
}
