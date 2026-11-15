import { MetaList } from "../../../shared/ui/MetaList";
import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { useI18n } from "../../../shared/i18n";
import type { BlockChoice, ConflictBlock } from "../model/conflict-blocks";
import type { SmartMergeOutcome } from "../model/smart-merge";
import { ConflictSideLines } from "./ConflictSideLines";

export type IgnoredSides = { ours?: boolean; theirs?: boolean };

export function ConflictBlockRow({ block, base, smart, ignored, busy, active, rowRef, onActivate, onApply, onIgnore, onSmartMerge }: {
  block: ConflictBlock;
  /** Common-ancestor text for this block, or `null` when it cannot be determined. */
  base: string | null;
  smart: SmartMergeOutcome;
  ignored: IgnoredSides;
  busy: boolean;
  active: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onActivate: () => void;
  onApply: (choice: BlockChoice) => void;
  onIgnore: (side: "ours" | "theirs") => void;
  onSmartMerge: () => void;
}) {
  const { t } = useI18n();
  const n = block.index;
  const merged = smart.kind === "merged" ? smart.text : null;
  return <article ref={rowRef} className={[active ? "active" : "", merged !== null ? "mergeable" : ""].filter(Boolean).join(" ")} onFocusCapture={onActivate} onClick={onActivate}>
    <header>
      <div>
        <strong>{t("cb.conflictN", { n })}</strong>
        {smart.kind === "merged" && <span className="conflictTag mergeable" title={t("cb.nonOverlappingTitle")}>{t("cb.nonOverlapping")}</span>}
        {smart.kind === "overlapping" && <span className="conflictTag overlapping" title={t("cb.overlappingTitle")}>{t("cb.overlapping")}</span>}
      </div>
      <MetaList items={[base !== null ? t("cb.againstBase") : t("cb.baseUnavailable"), t("cb.line", { line: block.line })]} />
    </header>
    <div className="conflictMergeRow">
      <div className={`conflictSide ours${ignored.ours ? " ignored" : ""}`} role="group" aria-label={t("cb.oursAria", { n })}>
        {ignored.ours && <span className="conflictIgnoredTag">{t("cb.ignored")}</span>}
        <ConflictSideLines text={block.ours} reference={base ?? block.theirs} startLine={block.line} />
      </div>
      <div className="conflictGutter">
        <button type="button" aria-label={t("cb.useOursAria", { n })} title={t("cb.acceptOurs")} disabled={busy || ignored.ours} onClick={() => onApply("ours")}><UiIcon name="chevronRight" /></button>
        <button type="button" className="conflictIgnore" aria-label={t("cb.ignoreOursAria", { n })} aria-pressed={Boolean(ignored.ours)} title={ignored.theirs ? t("cb.ignoreBoth") : t("cb.ignoreOurs")} disabled={busy} onClick={() => onIgnore("ours")}><UiIcon name="close" /></button>
      </div>
      <div className="conflictResultCell">
        {merged !== null
          ? <div className="conflictSide merged" role="group" aria-label={t("cb.smartPreviewAria", { n })}>
            <ConflictSideLines text={merged} reference={base} startLine={block.line} emptyLabel={t("cb.baseEmpty")} />
          </div>
          : <div className="conflictSide base" role="group" aria-label={t("cb.unresolvedAria", { n })}>
            {base !== null
              ? <ConflictSideLines text={base} reference={null} startLine={block.line} emptyLabel={t("cb.baseEmpty")} />
              : <div className="conflictLineEmpty">{t("cb.unresolvedHint")}</div>}
          </div>}
        <div className="conflictResultChoices">
          {merged !== null && <button type="button" className="conflictSmartButton" aria-label={t("cb.smartMergeAria", { n })} title={t("cb.smartMergeTitle")} disabled={busy || ignored.ours || ignored.theirs} onClick={onSmartMerge}>{t("cb.smartMerge")}</button>}
          <button type="button" aria-label={t("cb.useBothAria", { n })} title={t("cb.acceptBothTitle")} disabled={busy || ignored.ours || ignored.theirs} onClick={() => onApply("both")}>{t("cb.acceptBoth")}</button>
        </div>
      </div>
      <div className="conflictGutter">
        <button type="button" aria-label={t("cb.useTheirsAria", { n })} title={t("cb.acceptTheirs")} disabled={busy || ignored.theirs} onClick={() => onApply("theirs")}><UiIcon name="chevronLeft" /></button>
        <button type="button" className="conflictIgnore" aria-label={t("cb.ignoreTheirsAria", { n })} aria-pressed={Boolean(ignored.theirs)} title={ignored.ours ? t("cb.ignoreBoth") : t("cb.ignoreTheirs")} disabled={busy} onClick={() => onIgnore("theirs")}><UiIcon name="close" /></button>
      </div>
      <div className={`conflictSide theirs${ignored.theirs ? " ignored" : ""}`} role="group" aria-label={t("cb.theirsAria", { n })}>
        {ignored.theirs && <span className="conflictIgnoredTag">{t("cb.ignored")}</span>}
        <ConflictSideLines text={block.theirs} reference={base ?? block.ours} startLine={block.line} />
      </div>
    </div>
  </article>;
}
