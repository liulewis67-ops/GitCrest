import { Fragment, type ReactNode } from "react";

/**
 * Inline metadata items separated by a hairline divider instead of a typed separator glyph.
 * Items stay inline, so a parent with `text-overflow: ellipsis` still truncates the run.
 * Screen readers and copied text get a ", " between items. Empty items are skipped.
 */
export function MetaList({ items, className = "" }: { items: ReactNode[]; className?: string }) {
  const visible = items.filter((item) => item !== null && item !== undefined && item !== false && item !== "");
  return (
    <span className={`metaList ${className}`.trim()}>
      {visible.map((item, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="srOnly">, </span>}
          <span className="metaItem">{item}</span>
        </Fragment>
      ))}
    </span>
  );
}
