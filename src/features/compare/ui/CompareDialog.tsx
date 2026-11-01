import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useId, useRef, useState } from "react";
import { type CompareResultResponse, type DiffDocumentResponse, type GitCrestApiClient } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

type Mode = "threeDot" | "twoDot";
type CommitItem = CompareResultResponse["onlyInBase"]["items"][number];
type FileItem = CompareResultResponse["files"]["items"][number];
type ListKey = "onlyInBase" | "onlyInHead" | "files";

const PAGE = 100;

function errorMessage(error: unknown, fallback: string) {
  return describeApiError(error, fallback);
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString();
}

/**
 * Compares two branches, tags or commits, or a commit with the working tree. It only reads: it lists
 * the commits that are on one side only and the files that differ, and shows one file's change at a time.
 */
export function CompareDialog({ api, repoId, initial, currentBranch, refNames, onOpenFile, onClose }: {
  api: GitCrestApiClient;
  repoId: string;
  initial: { base?: string; head?: string; workingTree?: boolean };
  currentBranch?: string;
  /** Branch names offered as suggestions next to the repository's tags; any commit or relative name can be typed too. */
  refNames: readonly string[];
  /** Shows one file of the comparison in the read-only Diff window; without it the change is shown in the dialog. */
  onOpenFile?: (request: { path: string; fromOid: string; toOid?: string }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const listId = useId();
  const [base, setBase] = useState(initial.base ?? currentBranch ?? "");
  const [head, setHead] = useState(initial.head ?? "");
  const [workingTree, setWorkingTree] = useState(Boolean(initial.workingTree));
  const [mode, setMode] = useState<Mode>("threeDot");
  const [result, setResult] = useState<CompareResultResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const [more, setMore] = useState<ListKey | "">("");
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [selected, setSelected] = useState<FileItem>();
  const [document, setDocument] = useState<DiffDocumentResponse>();
  const [diffError, setDiffError] = useState<DisplayError>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const controllerRef = useRef<AbortController>();
  const requestRef = useRef(0);
  const autoRan = useRef(false);

  const trimmedBase = base.trim();
  const trimmedHead = head.trim();
  const blocker = !trimmedBase ? t("compare.needBase") : !workingTree && !trimmedHead ? t("compare.needHead") : "";

  function run() {
    if (blocker) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    setResult(undefined);
    setSelected(undefined);
    setDocument(undefined);
    api.withSignal(controller.signal)
      .compareRevisions(repoId, { base: trimmedBase, ...(workingTree ? {} : { head: trimmedHead }), mode, limit: PAGE })
      .then((next) => { if (request === requestRef.current) setResult(next); })
      .catch((reason) => {
        if (controller.signal.aborted || request !== requestRef.current) return;
        setError(errorMessage(reason, t("compare.failed")));
      })
      .finally(() => { if (request === requestRef.current) setLoading(false); });
  }

  function cancel() {
    controllerRef.current?.abort();
    requestRef.current += 1;
    setLoading(false);
    setMore("");
    setError(t("compare.cancelled"));
  }

  // Tags are offered as suggestions too; a failed read only leaves the list shorter.
  useEffect(() => {
    const controller = new AbortController();
    api.withSignal(controller.signal).getRepositoryTags(repoId, { limit: 500 })
      .then((page) => setTagNames(page.tags.map((tag) => tag.name)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [api, repoId]);

  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (initial.base && (initial.workingTree || initial.head)) run();
    return () => controllerRef.current?.abort();
  }, []);

  async function loadMore(key: ListKey) {
    if (!result || more) return;
    const request = requestRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setMore(key);
    try {
      const page = await api.withSignal(controller.signal).compareRevisions(repoId, {
        base: result.base,
        ...(result.head ? { head: result.head } : {}),
        mode: result.mode,
        offset: result[key].items.length,
        limit: PAGE,
      });
      if (request !== requestRef.current) return;
      setResult((current) => current && {
        ...current,
        [key]: { items: [...current[key].items, ...page[key].items] as never, hasMore: page[key].hasMore },
      });
    } catch (reason) {
      if (!controller.signal.aborted && request === requestRef.current) setError(errorMessage(reason, t("compare.failed")));
    } finally {
      if (request === requestRef.current) setMore("");
    }
  }

  function selectFile(file: FileItem) {
    setSelected(file);
    if (!onOpenFile || !result) return;
    setDiffError("");
    onOpenFile({ path: file.path, fromOid: result.fromOid, ...(result.headOid ? { toOid: result.headOid } : {}) })
      .catch((reason) => setDiffError(errorMessage(reason, t("compare.openFailed"))));
  }

  useEffect(() => {
    if (!result || !selected || onOpenFile) return;
    const controller = new AbortController();
    setDocument(undefined);
    setDiffError("");
    setDiffLoading(true);
    api.withSignal(controller.signal)
      .getRepositoryCompareDiff(repoId, { from: result.fromOid, ...(result.headOid ? { to: result.headOid } : {}), path: selected.path })
      .then(setDocument)
      .catch((reason) => { if (!controller.signal.aborted) setDiffError(errorMessage(reason, t("compare.diffFailed"))); })
      .finally(() => { if (!controller.signal.aborted) setDiffLoading(false); });
    return () => controller.abort();
  }, [api, repoId, result?.fromOid, result?.headOid, selected?.path]);

  const headLabel = result ? (result.head ?? t("compare.workingTree")) : "";

  const commitList = (key: "onlyInBase" | "onlyInHead", title: string, empty: string) => {
    if (!result) return null;
    const list = result[key];
    return <section aria-label={title} className="compareColumn">
      <h3>{title}<span className="compareCount">{list.items.length}{list.hasMore ? "+" : ""}</span></h3>
      {list.items.length === 0
        ? <p className="cloneHelp">{empty}</p>
        : <ul className="compareList">{list.items.map((commit: CommitItem) => <li key={commit.oid}>
          <code>{commit.shortOid}</code>
          <span className="reflogMessage" title={commit.subject}>{commit.subject || t("push.noSubject")}</span>
          <small title={commit.authorName}>{formatDate(commit.authoredAtMs)}</small>
        </li>)}</ul>}
      {list.hasMore && <Button variant="quiet" size="compact" type="button" disabled={Boolean(more)} onClick={() => void loadMore(key)}>{t("compare.loadMore")}</Button>}
    </section>;
  };

  return <Dialog className="cloneDialog compareDialog" role="dialog" aria-labelledby="compare-title" onClose={onClose} busy={false} closeLabel={t("common.close")}>
      <DialogHeader className="taskCenterHeader">
        <div><h2 id="compare-title">{t("compare.title")}</h2></div>

      </DialogHeader>
      <form className="cloneFormBody" onSubmit={(event) => { event.preventDefault(); run(); }}>
        <p className="cloneHelp">{t("compare.help")}</p>
        <datalist id={listId}>{[...refNames, ...tagNames.filter((name) => !refNames.includes(name))].map((name) => <option key={name} value={name} />)}</datalist>
        <div className="compareFields">
          <label className="rebaseTargetField">{t("compare.base")}
            <input value={base} list={listId} spellCheck={false} autoComplete="off" data-dialog-initial-focus onChange={(event) => setBase(event.target.value)} />
          </label>
          <label className="rebaseTargetField">{t("compare.head")}
            <input value={head} list={listId} spellCheck={false} autoComplete="off" disabled={workingTree} placeholder={workingTree ? t("compare.workingTree") : undefined} onChange={(event) => setHead(event.target.value)} />
          </label>
        </div>
        <label className="compareCheck"><input type="checkbox" checked={workingTree} onChange={(event) => setWorkingTree(event.target.checked)} />{t("compare.withTree")}</label>
        <fieldset className="compareMode" disabled={workingTree}>
          <legend>{t("compare.mode")}</legend>
          <label><input type="radio" name="compare-mode" checked={mode === "threeDot"} onChange={() => setMode("threeDot")} />{t("compare.threeDot")}</label>
          <label><input type="radio" name="compare-mode" checked={mode === "twoDot"} onChange={() => setMode("twoDot")} />{t("compare.twoDot")}</label>
        </fieldset>
        {blocker && <small className="cloneHelp">{blocker}</small>}
        {loading && <p role="status" className="cloneHelp">{t("compare.loading")}</p>}
        {error && <div className="statusLoadError" role="alert"><span><ErrorMessage error={error} /></span></div>}
        {result && <>
          <p className="cloneHelp" role="status">
            {t("compare.summary", { base: result.base, head: headLabel })}
            {result.mergeBaseOid && result.mode === "threeDot" ? ` ${t("compare.ancestor", { oid: result.mergeBaseOid.slice(0, 7) })}` : ""}
            {result.mode === "twoDot" && result.headOid ? ` ${t("compare.twoDotNote")}` : ""}
          </p>
          <div className="compareColumns">
            {commitList("onlyInBase", t("compare.onlyIn", { name: result.base }), t("compare.noneOnly", { name: result.base }))}
            {commitList("onlyInHead", t("compare.onlyIn", { name: headLabel }), t("compare.noneOnly", { name: headLabel }))}
          </div>
          <section aria-label={t("compare.files")}>
            <h3>{t("compare.files")}<span className="compareCount">{result.files.items.length}{result.files.hasMore ? "+" : ""}</span></h3>
            {result.files.items.length === 0
              ? <p className="cloneHelp">{t("compare.noFiles")}</p>
              : <ul className="compareList">{result.files.items.map((file) => <li key={`${file.originalPath ?? ""}>${file.path}`}>
                <span className="commitRefBadge">{t(`compare.kind.${file.kind}`)}</span>
                <Button type="button" variant="quiet" className="reflogMessage" aria-pressed={selected?.path === file.path} title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path} onClick={() => selectFile(file)}>{file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}</Button>
              </li>)}</ul>}
            {result.files.hasMore && <Button variant="quiet" size="compact" type="button" disabled={Boolean(more)} onClick={() => void loadMore("files")}>{t("compare.loadMore")}</Button>}
            {result.mode === "twoDot" && !result.headOid && <p className="cloneHelp">{t("compare.untrackedNote")}</p>}
          </section>
          {selected && onOpenFile && <section aria-label={t("compare.diffOf", { path: selected.path })} className="compareDiff">
            {diffError ? <div className="statusLoadError" role="alert"><span><ErrorMessage error={diffError} /></span></div> : <p className="cloneHelp" role="status">{t("compare.openedInWindow", { path: selected.path })}</p>}
          </section>}
          {selected && !onOpenFile && <section aria-label={t("compare.diffOf", { path: selected.path })} className="compareDiff">
            <h3>{selected.path}</h3>
            {diffLoading && <p role="status" className="cloneHelp">{t("compare.loading")}</p>}
            {diffError && <div className="statusLoadError" role="alert"><span><ErrorMessage error={diffError} /></span></div>}
            {document && (document.status === "text"
              ? <table className="compareDiffTable"><tbody>{document.hunks.flatMap((hunk, hunkIndex) => hunk.rows.map((row, rowIndex) => {
                const key = `${hunkIndex}:${rowIndex}`;
                if (row.kind === "context") return <tr key={key}><td className="compareLine">{row.oldLine}</td><td className="compareLine">{row.newLine}</td><td><code>{" "}{row.newText}</code></td></tr>;
                return [
                  row.oldText !== null && <tr key={`${key}-old`} className="compareRemoved"><td className="compareLine">{row.oldLine}</td><td className="compareLine" /><td><code>-{row.oldText}</code></td></tr>,
                  row.newText !== null && <tr key={`${key}-new`} className="compareAdded"><td className="compareLine" /><td className="compareLine">{row.newLine}</td><td><code>+{row.newText}</code></td></tr>,
                ];
              }))}</tbody></table>
              : <p className="cloneHelp">{document.status === "binary" ? t("compare.binary") : document.status === "empty" ? t("compare.emptyDiff") : t("compare.notText")}</p>)}
          </section>}
        </>}
        <DialogFooter className="compareActions"><Button variant="secondary" onClick={loading ? cancel : onClose}>{t("common.cancel")}</Button><Button variant="primary" type="submit" disabled={Boolean(blocker) || loading} title={blocker || undefined}>{t("compare.run")}</Button></DialogFooter>
      </form>
    </Dialog>;
}
