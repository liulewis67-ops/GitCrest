import { useI18n } from "../../../shared/i18n";
import type { DiffDocumentResponse } from "../../../api/client";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { fullFileSides } from "../model/full-file-diff";
import { monacoHighlightLanguageForPath } from "../model/monaco-language";
import { exceedsMonacoViewLimits } from "../model/monaco-view-limits";
import type { DiffViewPreferences } from "../model/use-diff-view-preferences";
import { DiffStatusNotice } from "./DiffStatusNotice";
import type { DiffPosition, MonacoFileDiffHandle } from "./MonacoFileDiff";

const MonacoFileDiff = lazy(() => import("./MonacoFileDiff").then((module) => ({ default: module.MonacoFileDiff })));

interface FileDiffViewerProps {
  /** A document read with `context=full`, so its hunk holds both complete files. */
  document: DiffDocumentResponse;
  commitOid?: string;
  preferences: DiffViewPreferences;
  onChangePreferences: (change: Partial<DiffViewPreferences>) => void;
  onShowHunks: () => void;
  onOpenWindow?: () => void;
}

/** Compares two whole versions of a file side by side, read-only. */
export function FileDiffViewer({ document, commitOid, preferences, onChangePreferences, onShowHunks, onOpenWindow }: FileDiffViewerProps) {
  const { t } = useI18n();
  const editorRef = useRef<MonacoFileDiffHandle>(null);
  const [position, setPosition] = useState<DiffPosition | null>(null);
  const sides = useMemo(() => fullFileSides(document), [document]);
  const tooLarge = useMemo(() => exceedsMonacoViewLimits(document.hunks), [document.hunks]);
  const language = monacoHighlightLanguageForPath(document.path);
  useEffect(() => setPosition(null), [document.revision]);

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

  return (
    <div className="fileDiffViewer" aria-label={t("sd.diffAria", { scope: document.scope, path: document.path })}>
      <div className="fileDiffToolbar" role="toolbar" aria-label={t("sd.navAria")}>
        <button className="fileDiffIconButton" type="button" aria-label={t("sd.prev")} title={t("sd.prevTitle")} disabled={tooLarge || !position?.total} onClick={() => editorRef.current?.goToDiff("previous")}>↑</button>
        <button className="fileDiffIconButton" type="button" aria-label={t("sd.next")} title={t("sd.nextTitle")} disabled={tooLarge || !position?.total} onClick={() => editorRef.current?.goToDiff("next")}>↓</button>
        <span className="fileDiffToolbarDivider" aria-hidden="true" />
        <select aria-label={t("fd.viewerAria")} value={preferences.sideBySide ? "sideBySide" : "unified"} onChange={(event) => onChangePreferences({ sideBySide: event.target.value === "sideBySide" })}>
          <option value="sideBySide">{t("fd.sideBySide")}</option>
          <option value="unified">{t("fd.unified")}</option>
        </select>
        <select aria-label={t("fd.whitespaceAria")} value={preferences.ignoreWhitespace ? "ignore" : "keep"} onChange={(event) => onChangePreferences({ ignoreWhitespace: event.target.value === "ignore" })}>
          <option value="keep">{t("fd.doNotIgnore")}</option>
          <option value="ignore">{t("fd.ignoreWhitespace")}</option>
        </select>
        <button type="button" aria-pressed={preferences.collapseUnchanged} title={t("fd.collapseTitle")} onClick={() => onChangePreferences({ collapseUnchanged: !preferences.collapseUnchanged })}>{t("fd.collapseUnchanged")}</button>
        <span className="fileDiffToolbarDivider" aria-hidden="true" />
        <button type="button" title={document.scope === "commit" ? t("fd.hunksTitle") : t("fd.selectLinesTitle")} onClick={onShowHunks}>{hunkToggleLabel}</button>
        {onOpenWindow && <button type="button" title={t("sd.openWindow")} aria-label={t("sd.openWindow")} onClick={onOpenWindow}>↗</button>}
        <span className="fileDiffDifferences" role="status" aria-live="polite">{tooLarge ? "" : differences}</span>
      </div>
      <div className={`fileDiffSides${preferences.sideBySide ? "" : " unified"}`}>
        {preferences.sideBySide ? <>
          <div title={leftLabel}><span className="fileDiffLock" aria-hidden="true">🔒</span>{leftLabel}{document.originalPath && <small>{document.originalPath}</small>}</div>
          <div title={rightLabel}>{rightLabel}<small>{document.path}</small></div>
        </> : <div><span className="fileDiffLock" aria-hidden="true">🔒</span>{leftLabel}<span aria-hidden="true">→</span>{rightLabel}<small>{document.originalPath ? `${document.originalPath} → ${document.path}` : document.path}</small></div>}
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
  );
}
