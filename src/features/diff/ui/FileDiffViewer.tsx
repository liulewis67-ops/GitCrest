import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { useI18n } from "../../../shared/i18n";
import type { DiffDocumentResponse } from "../../../api/client";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewStructure, SideLine } from "../model/code-review-analysis";
import { fullFileSides } from "../model/full-file-diff";
import { monacoHighlightLanguageForPath } from "../model/monaco-language";
import { exceedsMonacoViewLimits } from "../model/monaco-view-limits";
import { useCodeReviewAnalysis } from "../model/use-code-review-analysis";
import type { DiffViewPreferences } from "../model/use-diff-view-preferences";
import { DiffStatusNotice } from "./DiffStatusNotice";
import type { DiffPosition, MonacoFileDiffHandle } from "./MonacoFileDiff";
import { StructureOutline } from "./StructureOutline";

const MonacoFileDiff = lazy(() => import("./MonacoFileDiff").then((module) => ({ default: module.MonacoFileDiff })));

interface FileDiffViewerProps {
  /** A document read with `context=full`, so its hunk holds both complete files. */
  document: DiffDocumentResponse;
  commitOid?: string;
  preferences: DiffViewPreferences;
  onChangePreferences: (change: Partial<DiffViewPreferences>) => void;
  onShowHunks: () => void;
  onOpenWindow?: () => void;
  /** Groups the changes by code structure; selecting one for staging opens it in the line view. */
  structure?: { onSelectForStaging?: (structure: ReviewStructure) => void };
}

/** Compares two whole versions of a file side by side, read-only. */
export function FileDiffViewer({ document, commitOid, preferences, onChangePreferences, onShowHunks, onOpenWindow, structure }: FileDiffViewerProps) {
  const { t } = useI18n();
  const editorRef = useRef<MonacoFileDiffHandle>(null);
  const [position, setPosition] = useState<DiffPosition | null>(null);
  const [activeStructureId, setActiveStructureId] = useState<string | null>(null);
  const sides = useMemo(() => fullFileSides(document), [document]);
  const tooLarge = useMemo(() => exceedsMonacoViewLimits(document.hunks), [document.hunks]);
  const language = monacoHighlightLanguageForPath(document.path);
  const reviewState = useCodeReviewAnalysis({ path: document.path, fullDocument: structure ? document : undefined });
  const showStructure = Boolean(structure) && reviewState.status !== "off" && !tooLarge && document.status === "text";
  const outlineOpen = showStructure && preferences.structureOutline;
  const analysis = reviewState.status === "ready" ? reviewState.analysis : undefined;
  useEffect(() => setPosition(null), [document.revision]);
  useEffect(() => setActiveStructureId(null), [document.path, document.scope]);

  /** In the unified layout every line is shown by its new-side number; an old line maps to where it was removed. */
  const visibleLine = useCallback((at: SideLine): SideLine => {
    if (at.side === "new" || preferences.sideBySide) return at;
    let fallback = 1;
    for (const row of document.hunks.flatMap((hunk) => hunk.rows)) {
      if (row.newLine !== null) fallback = row.newLine;
      if (row.oldLine === at.line) return { side: "new", line: row.newLine ?? fallback };
    }
    return { side: "new", line: fallback };
  }, [document.hunks, preferences.sideBySide]);

  const jump = useCallback((at: SideLine) => {
    const target = visibleLine(at);
    editorRef.current?.revealLine(target.side, target.line);
  }, [visibleLine]);

  const activate = useCallback((focused: ReviewStructure) => {
    setActiveStructureId(focused.id);
    jump(focused.anchor);
  }, [jump]);

  // The focused structure's changed lines carry a gutter mark on both sides.
  const activeStructure = analysis?.structures.find((candidate) => candidate.id === activeStructureId);
  useEffect(() => {
    const old: number[] = [];
    const modified: number[] = [];
    for (const index of activeStructure ? [...activeStructure.atoms, ...activeStructure.memberAtoms] : []) {
      const atom = analysis?.atoms[index];
      if (atom && atom.oldLine !== null) old.push(atom.oldLine);
      if (atom && atom.newLine !== null) modified.push(atom.newLine);
    }
    editorRef.current?.highlightLines({ old, new: modified });
  }, [activeStructure, analysis]);

  if (document.status !== "text") return <DiffStatusNotice status={document.status} />;

  const shortOid = commitOid?.slice(0, 7);
  const [leftLabel, rightLabel] = document.scope === "commit"
    ? [shortOid ? `${shortOid}^` : t("fd.parent"), shortOid ?? t("fd.commit")]
    : document.scope === "index"
      ? ["HEAD", t("fd.staged")]
      : [document.changeKind === "untracked" || document.changeKind === "added" ? t("fd.noPrevious") : t("fd.staged"), t("fd.yourVersion")];
  const hunkToggleLabel = document.scope === "commit" ? t("fd.hunks") : t("fd.selectLines");
  const differences = position === null
    ? t("fd.comparing")
    : position.total === 0
      ? t("fd.noDifferences")
      : position.current > 0
        ? t("fd.differencePosition", { current: position.current, total: position.total })
        : t(position.total === 1 ? "fd.differencesOne" : "fd.differencesMany", { total: position.total });
  const toggleOutline = () => onChangePreferences({ structureOutline: !preferences.structureOutline });

  return (
    <div className="fileDiffViewer" aria-label={t("sd.diffAria", { scope: document.scope, path: document.path })}>
      <div className="fileDiffToolbar" role="toolbar" aria-label={t("sd.navAria")}>
        <button className="fileDiffIconButton" type="button" aria-label={t("sd.prev")} title={t("sd.prevTitle")} disabled={tooLarge || !position?.total} onClick={() => editorRef.current?.goToDiff("previous")}><UiIcon name="arrowUp" /></button>
        <button className="fileDiffIconButton" type="button" aria-label={t("sd.next")} title={t("sd.nextTitle")} disabled={tooLarge || !position?.total} onClick={() => editorRef.current?.goToDiff("next")}><UiIcon name="arrowDown" /></button>
        <span className="fileDiffToolbarDivider" aria-hidden="true" />
        {showStructure && <button type="button" aria-pressed={preferences.structureOutline} title={t("cr.toggleTitle")} onClick={toggleOutline}>{t("cr.toggle")}</button>}
        <SearchableSelect aria-label={t("fd.viewerAria")} value={preferences.sideBySide ? "sideBySide" : "unified"} onChange={(event) => onChangePreferences({ sideBySide: event.target.value === "sideBySide" })}>
          <option value="sideBySide">{t("fd.sideBySide")}</option>
          <option value="unified">{t("fd.unified")}</option>
        </SearchableSelect>
        <details className="fileDiffOptions" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary>{t("fd.options")}</summary><div className="fileDiffOptionsBody">
        <SearchableSelect aria-label={t("fd.whitespaceAria")} value={preferences.ignoreWhitespace ? "ignore" : "keep"} onChange={(event) => onChangePreferences({ ignoreWhitespace: event.target.value === "ignore" })}>
          <option value="keep">{t("fd.doNotIgnore")}</option>
          <option value="ignore">{t("fd.ignoreWhitespace")}</option>
        </SearchableSelect>
        <button type="button" aria-pressed={preferences.collapseUnchanged} title={t("fd.collapseTitle")} onClick={() => onChangePreferences({ collapseUnchanged: !preferences.collapseUnchanged })}>{t("fd.collapseUnchanged")}</button>
          </div></details>
        <span className="fileDiffToolbarDivider" aria-hidden="true" />
        <button type="button" title={document.scope === "commit" ? t("fd.hunksTitle") : t("fd.selectLinesTitle")} onClick={onShowHunks}>{hunkToggleLabel}</button>
        {onOpenWindow && <button type="button" title={t("sd.openWindow")} aria-label={t("sd.openWindow")} onClick={onOpenWindow}><UiIcon name="external" /></button>}
        <span className="fileDiffDifferences" role="status" aria-live="polite">{tooLarge ? "" : differences}</span>
      </div>
      <div className="fileDiffBody">
        {outlineOpen && <StructureOutline
          state={reviewState}
          activeId={activeStructureId}
          onActivate={activate}
          onJump={jump}
          reviewKey={document.scope === "commit" ? undefined : `${document.repoId}\u0000${document.scope}\u0000${document.path}`}
          onSelectForStaging={document.scope === "commit" ? undefined : structure?.onSelectForStaging}
          onClose={toggleOutline}
        />}
        <div className="fileDiffMain">
          <div className={`fileDiffSides${preferences.sideBySide ? "" : " unified"}`}>
            {preferences.sideBySide ? <>
              <div title={leftLabel}><span className="fileDiffLock" aria-hidden="true"><UiIcon name="lock" /></span>{leftLabel}{document.originalPath && <small>{document.originalPath}</small>}</div>
              <div title={rightLabel}>{rightLabel}<small>{document.path}</small></div>
            </> : <div><span className="fileDiffLock" aria-hidden="true"><UiIcon name="lock" /></span>{leftLabel}<span aria-hidden="true"><UiIcon name="arrowRight" /></span>{rightLabel}<small>{document.originalPath ? `${document.originalPath} → ${document.path}` : document.path}</small></div>}
          </div>
          {tooLarge ? <div className="diffSpecialState" role="status">
            <p>{t("fd.tooLarge")}</p>
            <button className="secondaryButton" type="button" onClick={onShowHunks}>{t("fd.hunks")}</button>
          </div> : <Suspense fallback={<div className="diffSpecialState" role="status" aria-live="polite">{t("sd.loadingMonaco")}</div>}>
            <MonacoFileDiff
              ref={editorRef}
              label={t("fd.editorAria", { path: document.path })}
              original={sides.original}
              modified={sides.modified}
              language={language}
              sideBySide={preferences.sideBySide}
              ignoreWhitespace={preferences.ignoreWhitespace}
              collapseUnchanged={preferences.collapseUnchanged}
              onPositionChange={setPosition}
            />
          </Suspense>}
        </div>
      </div>
    </div>
  );
}
