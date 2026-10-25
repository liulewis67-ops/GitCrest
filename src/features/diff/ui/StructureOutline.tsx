import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useI18n, type MessageKey } from "../../../shared/i18n";
import { OTHER_STRUCTURE_ID, type ChangeFactKind, type CodeReviewAnalysis, type ReviewStructure, type SideLine } from "../model/code-review-analysis";
import type { CodeReviewState } from "../model/use-code-review-analysis";
import { useReviewedStructures } from "../model/use-reviewed-structures";

export type StructureSelectionState = "all" | "some" | "none";

export interface StructureSelectionControls {
  stateOf: (structure: ReviewStructure) => StructureSelectionState;
  select: (structure: ReviewStructure, includeMembers: boolean) => void;
  deselect: (structure: ReviewStructure) => void;
  disabled: boolean;
  /** Shared rows the last structure selection left out. */
  withheld?: number;
  /** Shared rows of which the last structure selection took only the structure's own side. */
  halves?: number;
}

interface StructureOutlineProps {
  state: CodeReviewState;
  activeId: string | null;
  onActivate: (structure: ReviewStructure) => void;
  onJump: (at: SideLine) => void;
  /** Identifies the file and comparison for review marks; omitted where marks do not apply. */
  reviewKey?: string;
  /** Present where rows can be selected for staging. */
  selection?: StructureSelectionControls;
  /** Present where rows cannot be selected here but can be in the line view. */
  onSelectForStaging?: (structure: ReviewStructure) => void;
  onRefresh?: () => void;
  onClose: () => void;
}

const FACT_LABELS: Record<ChangeFactKind, MessageKey> = {
  added: "cr.factAdded",
  removed: "cr.factRemoved",
  parameters: "cr.factParameters",
  returnType: "cr.factReturnType",
  body: "cr.factBody",
  declaration: "cr.factDeclaration",
  modifiers: "cr.factModifiers",
  annotations: "cr.factAnnotations",
  comments: "cr.factComments",
  formatting: "cr.factFormatting",
  debug: "cr.factDebug",
  content: "cr.factContent",
  value: "cr.factValue",
  members: "cr.factMembers",
};

const STATUS_GLYPHS: Record<ReviewStructure["status"], string> = { added: "+", removed: "−", modified: "●" };

export function structureDisplayName(structure: ReviewStructure, t: (key: MessageKey) => string): string {
  if (structure.kind === "imports") return t("cr.imports");
  if (structure.id === OTHER_STRUCTURE_ID) return t("cr.other");
  if (structure.kind === "function" || structure.kind === "method") return `${structure.name}${structure.detail ?? "()"}`;
  return structure.name;
}

/** The list of changed structures in one file diff, with what changed in the focused one. */
export function StructureOutline({ state, activeId, onActivate, onJump, reviewKey, selection, onSelectForStaging, onRefresh, onClose }: StructureOutlineProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const [hideNoise, setHideNoise] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const { isReviewed, toggleReviewed } = useReviewedStructures(reviewKey ?? "");
  const analysis = state.status === "ready" ? state.analysis : undefined;
  const byId = useMemo(() => new Map((analysis?.structures ?? []).map((structure) => [structure.id, structure])), [analysis]);
  const noiseCount = analysis?.structures.filter((structure) => structure.noise).length ?? 0;
  const visible = useMemo(() => {
    if (!analysis) return [];
    const query = filter.trim().toLowerCase();
    if (!query && !hideNoise) return analysis.structures;
    // A match keeps its ancestors, so it is still shown inside its class or impl.
    const keep = new Set<string>();
    for (const structure of analysis.structures) {
      if (query && !structureDisplayName(structure, t).toLowerCase().includes(query)) continue;
      if (hideNoise && (structure.noise || (structure.atoms.length === 0 && structure.memberAtoms.length > 0))) continue;
      let current: ReviewStructure | undefined = structure;
      while (current && !keep.has(current.id)) {
        keep.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
    }
    return analysis.structures.filter((structure) => keep.has(structure.id));
  }, [analysis, byId, filter, hideNoise, t]);
  const active = activeId ? byId.get(activeId) : undefined;
  const listedCount = analysis?.structures.filter((structure) => structure.atoms.length > 0).length ?? 0;
  // Review progress counts structures with changes of their own; containers are covered by their members.
  const reviewable = reviewKey === undefined ? [] : visible.filter((structure) => structure.atoms.length > 0);
  const reviewedCount = reviewable.filter((structure) => isReviewed(structure)).length;

  function focusItem(id: string) {
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-structure-id="${CSS.escape(id)}"]`)?.focus());
  }

  /** Moves to the next structure, after the focused one, that is not marked reviewed. */
  function nextUnreviewed() {
    const start = active ? reviewable.indexOf(active) : -1;
    for (let step = 1; step <= reviewable.length; step += 1) {
      const candidate = reviewable[(start + step + reviewable.length) % reviewable.length];
      if (candidate && !isReviewed(candidate)) {
        onActivate(candidate);
        focusItem(candidate.id);
        return;
      }
    }
  }

  function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.key === "n" || event.key === "N") && !event.ctrlKey && !event.metaKey && !event.altKey && reviewable.length > 0) {
      event.preventDefault();
      nextUnreviewed();
      return;
    }
    const items = [...(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])];
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === "ArrowDown") next = Math.min(items.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <aside className="structureOutline" aria-label={t("cr.title")}>
      <header className="structureOutlineHeader">
        <strong>{t("cr.title")}</strong>
        {analysis && <span>{t("cr.summary", { structures: listedCount, lines: analysis.atoms.length })}</span>}
        <button className="structureOutlineClose" type="button" aria-label={t("cr.hide")} title={t("cr.hide")} onClick={onClose}>×</button>
      </header>
      {state.status === "analyzing" && <p className="structureOutlineNote" role="status"><span className="loadingSpinner" aria-hidden="true" />{t("cr.analyzing")}</p>}
      {state.status === "unavailable" && <p className="structureOutlineNote" role="status">{t(state.reason === "tooLarge" ? "cr.tooLarge" : state.reason === "fullFile" ? "cr.fullFile" : "cr.parserUnavailable")}</p>}
      {state.status === "stale" && <div className="structureOutlineNote" role="status"><p>{t("cr.stale")}</p>{onRefresh && <button className="secondaryButton" type="button" onClick={onRefresh}>{t("cr.refresh")}</button>}</div>}
      {analysis && <>
        <input className="structureOutlineFilter" type="search" value={filter} placeholder={t("cr.filter")} aria-label={t("cr.filter")} onChange={(event) => setFilter(event.target.value)} />
        {(reviewable.length > 0 || noiseCount > 0) && <div className="structureOutlineTools">
          {reviewable.length > 0 && <span className="structureProgress" role="status">{t("cr.reviewProgress", { done: reviewedCount, total: reviewable.length })}</span>}
          {reviewable.length > 0 && <button type="button" title={t("cr.nextUnreviewedTitle")} disabled={reviewedCount === reviewable.length} onClick={nextUnreviewed}>
            {reviewedCount === reviewable.length ? t("cr.allReviewed") : t("cr.nextUnreviewed")}
          </button>}
          {noiseCount > 0 && <button type="button" aria-pressed={hideNoise} onClick={() => setHideNoise((current) => !current)}>
            {t(hideNoise ? "cr.showNoise" : "cr.hideNoise", { count: noiseCount })}
          </button>}
        </div>}
        {analysis.partial && <p className="structureOutlineNote warning" role="note">{t("cr.partial")}</p>}
        <div className="structureTree" role="tree" aria-label={t("cr.treeAria")} ref={treeRef} onKeyDown={onTreeKeyDown}>
          {visible.length === 0 && <p className="structureOutlineNote">{t("cr.noMatch")}</p>}
          {visible.map((structure, index) => {
            const selected = structure.id === activeId;
            const reviewed = reviewKey !== undefined && structure.atoms.length > 0 && isReviewed(structure);
            const count = structure.atoms.length + structure.memberAtoms.length;
            return (
              <div
                key={structure.id}
                className={`structureItem status-${structure.status}${selected ? " active" : ""}${reviewed ? " reviewed" : ""}`}
                role="treeitem"
                data-structure-id={structure.id}
                aria-level={structure.depth + 1}
                aria-selected={selected}
                tabIndex={selected || (!active && index === 0) ? 0 : -1}
                style={{ paddingLeft: `${8 + structure.depth * 14}px` }}
                title={structure.id === OTHER_STRUCTURE_ID ? t("cr.otherHint") : undefined}
                onClick={() => onActivate(structure)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onActivate(structure);
                }}
              >
                <span className="structureStatus" aria-label={t(structure.status === "added" ? "cr.statusAdded" : structure.status === "removed" ? "cr.statusRemoved" : "cr.statusModified")}>{STATUS_GLYPHS[structure.status]}</span>
                <span className="structureKind">{t(`cr.kind.${structure.kind}` as MessageKey)}</span>
                <span className="structureName">{structureDisplayName(structure, t)}</span>
                {reviewed && <span className="structureReviewed" aria-label={t("cr.reviewed")}>✓</span>}
                <span className="structureCount" aria-label={t("cr.lines", { count })}>{count}</span>
              </div>
            );
          })}
        </div>
        {active && <StructureDetail
          analysis={analysis}
          structure={active}
          byId={byId}
          reviewed={reviewKey !== undefined ? isReviewed(active) : undefined}
          onToggleReviewed={() => toggleReviewed(active)}
          onJump={onJump}
          selection={selection}
          onSelectForStaging={onSelectForStaging}
        />}
      </>}
    </aside>
  );
}

interface StructureDetailProps {
  analysis: CodeReviewAnalysis;
  structure: ReviewStructure;
  byId: Map<string, ReviewStructure>;
  reviewed?: boolean;
  onToggleReviewed: () => void;
  onJump: (at: SideLine) => void;
  selection?: StructureSelectionControls;
  onSelectForStaging?: (structure: ReviewStructure) => void;
}

function StructureDetail({ analysis, structure, byId, reviewed, onToggleReviewed, onJump, selection, onSelectForStaging }: StructureDetailProps) {
  const { t } = useI18n();
  const path: string[] = [];
  for (let current: ReviewStructure | undefined = structure; current; current = current.parentId ? byId.get(current.parentId) : undefined) {
    path.unshift(structureDisplayName(current, t));
  }
  const sharedWith = new Set<string>();
  for (const index of structure.sharedAtoms) {
    for (const owner of analysis.atoms[index]?.owners ?? []) {
      if (owner !== structure.id) sharedWith.add(byId.get(owner) ? structureDisplayName(byId.get(owner)!, t) : t("cr.other"));
    }
  }
  const selectionState = selection?.stateOf(structure) ?? "none";
  const hasOwn = structure.atoms.length > 0;
  const hasMembers = structure.memberAtoms.length > 0;

  return (
    <section className="structureDetail" aria-label={path.join(" › ")}>
      <p className="structurePath" title={path.join(" › ")}>{path.join(" › ")}</p>
      {structure.facts.length > 0 && <div className="structureFacts" role="group" aria-label={t("cr.factsAria")}>
        {structure.facts.map((fact) => <button
          key={fact.kind}
          type="button"
          className={`structureFact fact-${fact.kind}`}
          title={t("cr.factTitle", { side: t(fact.at.side === "old" ? "cr.sideOld" : "cr.sideNew"), line: fact.at.line })}
          onClick={() => onJump(fact.at)}
        >{t(FACT_LABELS[fact.kind])}</button>)}
      </div>}
      <p className="structureCounts">
        {t("cr.counts", { own: structure.atoms.length })}
        {hasMembers && <> · {t("cr.memberCounts", { count: structure.memberAtoms.length })}</>}
      </p>
      {structure.sharedAtoms.length > 0 && <p className="structureShared" title={t("cr.sharedHint")}>⇄ {t("cr.shared", { count: structure.sharedAtoms.length, names: [...sharedWith].join(", ") })}</p>}
      {!structure.reliable && <p className="structureOutlineNote warning">{t("cr.notSelectable")}</p>}
      <div className="structureActions">
        {selection && structure.reliable && (hasOwn || hasMembers) && (selectionState === "all"
          ? <button type="button" disabled={selection.disabled} onClick={() => selection.deselect(structure)}>{t("cr.deselect")}</button>
          : <>
            {hasOwn && <button type="button" className="primary" disabled={selection.disabled} onClick={() => selection.select(structure, false)}>{t("cr.select")}</button>}
            {hasMembers && <button type="button" className={hasOwn ? undefined : "primary"} disabled={selection.disabled} onClick={() => selection.select(structure, true)}>{t("cr.selectMembers")}</button>}
          </>)}
        {onSelectForStaging && structure.reliable && (hasOwn || hasMembers) && <button type="button" className="primary" title={t("cr.selectForStagingTitle")} onClick={() => onSelectForStaging(structure)}>{t("cr.selectForStaging")}</button>}
        {reviewed !== undefined && hasOwn && <button type="button" aria-pressed={reviewed} title={t("cr.reviewedHint")} onClick={onToggleReviewed}>{reviewed ? t("cr.unmarkReviewed") : t("cr.markReviewed")}</button>}
      </div>
      {selection?.halves ? <p className="structureShared" role="status">{t("cr.halves", { count: selection.halves })}</p> : null}
      {selection?.withheld ? <p className="structureShared" role="status">{t("cr.withheld", { count: selection.withheld })}</p> : null}
    </section>
  );
}
