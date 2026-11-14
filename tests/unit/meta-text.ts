/**
 * Text matcher for a MetaList run. Its items sit in separate spans, joined for assistive
 * technology by hidden ", " separators, so the whole run is matched on textContent.
 */
export function metaText(expected: string | RegExp) {
  return (_content: string, element: Element | null) => {
    if (!element?.classList.contains("metaList")) return false;
    const text = element.textContent ?? "";
    return typeof expected === "string" ? text === expected : expected.test(text);
  };
}
