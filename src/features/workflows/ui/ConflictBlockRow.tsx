import type { BlockChoice, ConflictBlock } from "../model/conflict-blocks";
import { ConflictSideLines } from "./ConflictSideLines";

export type IgnoredSides = { ours?: boolean; theirs?: boolean };

export function ConflictBlockRow({ block, base, ignored, busy, active, rowRef, onActivate, onApply, onIgnore }: {
  block: ConflictBlock;
  /** Common-ancestor text for this block, or `null` when it cannot be determined. */
  base: string | null;
  ignored: IgnoredSides;
  busy: boolean;
  active: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onActivate: () => void;
  onApply: (choice: BlockChoice) => void;
  onIgnore: (side: "ours" | "theirs") => void;
}) {
  const n = block.index;
  return <article ref={rowRef} className={active ? "active" : ""} onFocusCapture={onActivate} onClick={onActivate}>
    <header>
      <strong>Conflict {n}</strong>
      <span>{base !== null ? "Changes shown against base" : "Base unavailable · sides compared with each other"} · Line {block.line}</span>
    </header>
    <div className="conflictMergeRow">
      <div className={`conflictSide ours${ignored.ours ? " ignored" : ""}`} role="group" aria-label={`Ours for conflict ${n}`}>
        {ignored.ours && <span className="conflictIgnoredTag">Ignored</span>}
        <ConflictSideLines text={block.ours} reference={base ?? block.theirs} startLine={block.line} />
      </div>
      <div className="conflictGutter">
        <button type="button" aria-label={`Use ours for conflict ${n}`} title="Accept ours (Alt+1)" disabled={busy || ignored.ours} onClick={() => onApply("ours")}>»</button>
        <button type="button" className="conflictIgnore" aria-label={`Ignore ours for conflict ${n}`} aria-pressed={Boolean(ignored.ours)} title={ignored.theirs ? "Ignore both sides: keep the base text" : "Ignore ours"} disabled={busy} onClick={() => onIgnore("ours")}>×</button>
      </div>
      <div className="conflictResultCell">
        <div className="conflictSide base" role="group" aria-label={`Unresolved result for conflict ${n}`}>
          {base !== null
            ? <ConflictSideLines text={base} reference={null} startLine={block.line} emptyLabel="(base is empty)" />
            : <div className="conflictLineEmpty">Unresolved — choose a side or edit the result below</div>}
        </div>
        <button type="button" aria-label={`Use both for conflict ${n}`} title="Accept ours, then theirs (Alt+3)" disabled={busy || ignored.ours || ignored.theirs} onClick={() => onApply("both")}>Accept both</button>
      </div>
      <div className="conflictGutter">
        <button type="button" aria-label={`Use theirs for conflict ${n}`} title="Accept theirs (Alt+2)" disabled={busy || ignored.theirs} onClick={() => onApply("theirs")}>«</button>
        <button type="button" className="conflictIgnore" aria-label={`Ignore theirs for conflict ${n}`} aria-pressed={Boolean(ignored.theirs)} title={ignored.ours ? "Ignore both sides: keep the base text" : "Ignore theirs"} disabled={busy} onClick={() => onIgnore("theirs")}>×</button>
      </div>
      <div className={`conflictSide theirs${ignored.theirs ? " ignored" : ""}`} role="group" aria-label={`Theirs for conflict ${n}`}>
        {ignored.theirs && <span className="conflictIgnoredTag">Ignored</span>}
        <ConflictSideLines text={block.theirs} reference={base ?? block.ours} startLine={block.line} />
      </div>
    </div>
  </article>;
}
