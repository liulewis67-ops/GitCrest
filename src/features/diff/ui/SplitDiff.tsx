import { useI18n } from "../../../shared/i18n";
import type { DiffDocumentResponse } from "../../../api/client";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitInlineDiff } from "../model/inline-diff";
import { monacoLanguageForPath } from "../model/monaco-language";
import { exceedsMonacoViewLimits } from "../model/monaco-view-limits";

const MonacoDiffHunk = lazy(() => import("./MonacoDiffHunk").then((module) => ({ default: module.MonacoDiffHunk })));

interface SplitDiffProps {
  document: DiffDocumentResponse;
  onStageSelection: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  onDiscardSelection?: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  onCommitSelection?: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  disabled: boolean;
  readOnly?: boolean;
  onOpenWindow?: () => void;
}

export function SplitDiff({ document, onStageSelection, onDiscardSelection, onCommitSelection, disabled, readOnly: readOnlyOverride = false, onOpenWindow }: SplitDiffProps) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<Array<{ hunkIndex: number; rowIndex?: number }>>([]);
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(() => new Set());
  const [activeHunk, setActiveHunk] = useState<number | null>(null);
  const [view, setView] = useState<"split" | "monaco">("split");
  const hunkRefs = useRef<Array<HTMLElement | null>>([]);
  const readOnly = readOnlyOverride || document.scope === "commit";
  const language = monacoLanguageForPath(document.path);
  const monacoDegraded = exceedsMonacoViewLimits(document.hunks);
  const navigableHunks = useMemo(() => document.status === "text"
    ? document.hunks.flatMap((hunk, hunkIndex) => hunk.rows.some((row) => row.kind === "change") ? [hunkIndex] : [])
    : [], [document.hunks, document.status]);
  useEffect(() => {
    setSelection([]);
    setCollapsedHunks(new Set());
    setActiveHunk(null);
    setView("split");
    hunkRefs.current = [];
  }, [document.revision]);
  const navigateHunk = useCallback((direction: -1 | 1) => {
    if (navigableHunks.length === 0) return;
    const activeIndex = activeHunk === null ? -1 : navigableHunks.indexOf(activeHunk);
    const nextIndex = activeIndex === -1
      ? (direction === 1 ? 0 : navigableHunks.length - 1)
      : (activeIndex + direction + navigableHunks.length) % navigableHunks.length;
    const nextHunk = navigableHunks[nextIndex];
    if (nextHunk === undefined) return;
    setCollapsedHunks((current) => {
      if (!current.has(nextHunk)) return current;
      const next = new Set(current);
      next.delete(nextHunk);
      return next;
    });
    setActiveHunk(nextHunk);
    requestAnimationFrame(() => hunkRefs.current[nextHunk]?.scrollIntoView?.({ block: "nearest" }));
  }, [activeHunk, navigableHunks]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F7" || event.altKey || event.ctrlKey || event.metaKey || navigableHunks.length === 0) return;
      if (event.target instanceof HTMLElement && event.target.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      navigateHunk(event.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [document.revision, navigateHunk, navigableHunks.length]);
  if (document.status !== "text") {
    const descriptions: Record<DiffDocumentResponse["status"], string> = {
      text: t("sd.text"),
      binary: t("sd.binary"),
      empty: t("sd.empty"),
      conflicted: t("sd.conflicted"),
      ignored: t("sd.ignored"),
      symlink: t("sd.symlink"),
      submodule: t("sd.submodule"),
    };
    return <div className="diffSpecialState" role="status"><span className={`diffStateBadge diffState-${document.status}`}>{document.status}</span><p>{descriptions[document.status]}</p></div>;
  }

  return (
    <div
      className="splitDiff"
      aria-label={t("sd.diffAria", { scope: document.scope, path: document.path })}
      tabIndex={0}
    >
      <div className="splitDiffFileMeta"><span className="diffScopeBadge">{document.scope === "commit" ? t("sd.scopeCommit") : document.scope === "index" ? t("sd.scopeIndex") : t("sd.scopeWorking")}</span><strong>{document.path}</strong>{document.originalPath && <small>{document.originalPath} → {document.path}</small>}</div>
      <div className="splitDiffNavigation" aria-label={t("sd.navAria")}>
        <span>{navigableHunks.length ? t("sd.changes", { current: activeHunk === null ? 0 : navigableHunks.indexOf(activeHunk) + 1, total: navigableHunks.length }) : t("sd.noChanges")}</span>
        <button type="button" aria-pressed={view === "split"} onClick={() => setView("split")}>{t("sd.splitView")}</button>
        <button type="button" aria-pressed={view === "monaco"} disabled={monacoDegraded} title={monacoDegraded ? t("sd.monacoTooLargeTitle") : undefined} onClick={() => setView("monaco")}>{t("sd.monacoView")}</button>
        {onOpenWindow && <button type="button" onClick={onOpenWindow}>{t("sd.openWindow")}</button>}
        <button type="button" onClick={() => navigateHunk(-1)} disabled={navigableHunks.length === 0} title={t("sd.prevTitle")}>{t("sd.prev")}</button>
        <button type="button" onClick={() => navigateHunk(1)} disabled={navigableHunks.length === 0} title={t("sd.nextTitle")}>{t("sd.next")}</button>
      </div>
      {monacoDegraded && <div className="diffSyntaxFallback" role="status">{t("sd.monacoTooLarge")}</div>}
      <div className="splitDiffColumns" aria-hidden="true"><div /><div>{t("sd.old")}</div><div>{t("sd.new")}</div></div>
      {view === "monaco" && !language.supported && <div className="diffSyntaxFallback" role="status">{t("sd.noGrammar")}</div>}
      {document.hunks.map((hunk, hunkIndex) => {
        const changeRowIndexes = hunk.rows.flatMap((row, rowIndex) => row.kind === "change" ? [rowIndex] : []);
        const hunkSelected = selection.some((item) => item.hunkIndex === hunkIndex && item.rowIndex === undefined);
        const allRowsSelected = changeRowIndexes.length > 0 && changeRowIndexes.every((rowIndex) => selection.some((item) => item.hunkIndex === hunkIndex && (item.rowIndex === undefined || item.rowIndex === rowIndex)));
        return (
        <section
          className={`splitDiffHunk${activeHunk === hunkIndex ? " splitDiffHunk-active" : ""}`}
          key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}
          aria-label={t("sd.hunkAria", { n: hunkIndex + 1 })}
          ref={(element) => { hunkRefs.current[hunkIndex] = element; }}
        >
          <div className="splitDiffHunkHeader">
            {!readOnly ? <label className="hunkSelection"><input
              type="checkbox"
              aria-label={t("sd.selectHunkAria", { n: hunkIndex + 1 })}
              checked={hunkSelected || allRowsSelected}
              disabled={disabled || changeRowIndexes.length === 0}
              onChange={(event) => setSelection((current) => {
                const rest = current.filter((item) => item.hunkIndex !== hunkIndex);
                return event.target.checked ? [...rest, { hunkIndex }] : rest;
              })}
            />{t("sd.selectHunk")}</label> : <span className="hunkSelection">{t("sd.hunkLabel", { n: hunkIndex + 1 })}</span>}
            <code>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</code>
            <button
              type="button"
              className="diffHunkToggle"
              aria-expanded={!collapsedHunks.has(hunkIndex)}
              aria-label={collapsedHunks.has(hunkIndex) ? t("sd.expandAria", { n: hunkIndex + 1 }) : t("sd.collapseAria", { n: hunkIndex + 1 })}
              onClick={() => setCollapsedHunks((current) => {
                const next = new Set(current);
                if (next.has(hunkIndex)) next.delete(hunkIndex);
                else next.add(hunkIndex);
                return next;
              })}
            >{collapsedHunks.has(hunkIndex) ? t("sd.expand") : t("sd.collapse")}</button>
          </div>
          {!collapsedHunks.has(hunkIndex) && view === "monaco" && <Suspense fallback={<div className="monacoDiffLoading" role="status">{t("sd.loadingMonaco")}</div>}>
            <MonacoDiffHunk
              label={t("sd.monacoHunk", { n: hunkIndex + 1 })}
              original={hunk.rows.flatMap((row) => row.oldText === null || row.oldText === undefined ? [] : [row.oldText]).join("\n")}
              modified={hunk.rows.flatMap((row) => row.newText === null || row.newText === undefined ? [] : [row.newText]).join("\n")}
              language={language.id}
              treeSitterGrammar={language.treeSitterGrammar}
              height={Math.min(480, Math.max(120, hunk.rows.length * 20 + 24))}
            />
          </Suspense>}
          {!collapsedHunks.has(hunkIndex) && view === "split" && hunk.rows.map((row, rowIndex) => (
            <div className={`splitDiffRow splitDiffRow-${row.kind}`} role="group" aria-label={row.kind === "change" ? t("sd.changedLines") : t("sd.contextLines")} key={`${hunkIndex}:${rowIndex}`}>
              {row.kind === "change" && !readOnly ? <label className="diffRowSelect"><input
                type="checkbox"
                aria-label={t("sd.selectRowAria", { hunk: hunkIndex + 1, row: rowIndex + 1 })}
                checked={selection.some((item) => item.hunkIndex === hunkIndex && (item.rowIndex === undefined || item.rowIndex === rowIndex))}
                disabled={disabled}
                onChange={(event) => setSelection((current) => {
                  const isHunkSelected = current.some((item) => item.hunkIndex === hunkIndex && item.rowIndex === undefined);
                  const rows = isHunkSelected
                    ? changeRowIndexes.map((rowIndex) => ({ hunkIndex, rowIndex }))
                    : current.filter((item) => item.hunkIndex !== hunkIndex || item.rowIndex !== undefined);
                  const exists = rows.some((item) => item.hunkIndex === hunkIndex && item.rowIndex === rowIndex);
                  const next = event.target.checked
                    ? (exists ? rows : [...rows, { hunkIndex, rowIndex }])
                    : rows.filter((item) => !(item.hunkIndex === hunkIndex && item.rowIndex === rowIndex));
                  return [...next.filter((item) => item.hunkIndex !== hunkIndex), ...next.filter((item) => item.hunkIndex === hunkIndex)];
                })}
              /></label> : <span className="diffRowSelect" aria-hidden="true" />}
              <div
                className="splitDiffCell"
                role="group"
                aria-label={row.oldText === null
                  ? t("sd.noPrevious")
                  : row.kind === "change"
                    ? t("sd.deletedLine", { line: row.oldLine ?? t("sd.unknown"), text: row.oldText })
                    : t("sd.contextLine", { line: row.oldLine ?? t("sd.unknown"), text: row.oldText })}
              >
                <span className="splitDiffLineNumber">{row.oldLine ?? ""}</span>
                <code>{row.oldText !== null && row.oldText !== undefined && row.kind === "change" ? <InlineDiffText text={row.oldText} counterpart={row.newText ?? null} /> : row.oldText ?? ""}</code>
              </div>
              <div
                className="splitDiffCell"
                role="group"
                aria-label={row.newText === null
                  ? t("sd.noAdded")
                  : row.kind === "change"
                    ? t("sd.addedLine", { line: row.newLine ?? t("sd.unknown"), text: row.newText })
                    : t("sd.contextLine", { line: row.newLine ?? t("sd.unknown"), text: row.newText })}
              >
                <span className="splitDiffLineNumber">{row.newLine ?? ""}</span>
                <code>{row.newText !== null && row.newText !== undefined && row.kind === "change" ? <InlineDiffText text={row.newText} counterpart={row.oldText ?? null} /> : row.newText ?? ""}</code>
              </div>
            </div>
          ))}
        </section>
        );
      })}
      {!readOnly && <div className="diffSelectionActions">
        <span>{t(selection.length === 1 ? "sd.selectionOne" : "sd.selectionMany", { count: selection.length })}</span>
        <button type="button" disabled={disabled || selection.length === 0} onClick={() => onStageSelection(selection)}>
          {document.scope === "index" ? t("sd.unstageSel") : t("sd.stageSel")}
        </button>
        {document.scope === "workingTree" && onDiscardSelection && <button className="dangerTextButton" type="button" disabled={disabled || selection.length === 0} onClick={() => onDiscardSelection(selection)}>{t("sd.discardSel")}</button>}
        {document.scope === "index" && onCommitSelection && <button type="button" disabled={disabled || selection.length === 0} onClick={() => onCommitSelection(selection)}>{t("sd.addToCommit")}</button>}
      </div>}
    </div>
  );
}

function InlineDiffText({ text, counterpart }: { text: string; counterpart: string | null }) {
  const segments = splitInlineDiff(text, counterpart);
  return <>{segments.map((segment, index) => segment.changed
    ? <mark className="diffInlineChange" key={index}>{segment.text}</mark>
    : <span key={index}>{segment.text}</span>)}</>;
}
