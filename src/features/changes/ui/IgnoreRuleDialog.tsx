import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState } from "react";
import { type GitCrestApiClient, type IgnoreRuleResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";

export type IgnoreMode = "file" | "extension" | "folder";
type IgnoreTarget = "gitignore" | "exclude";

function errorMessage(error: unknown, fallback: string) {
  return describeApiError(error, fallback);
}

/**
 * Adds one ignore rule for an untracked path. It shows the exact line and the file it goes into
 * first; the result is an ordinary edit of `.gitignore` (or the private exclude file).
 */
export function IgnoreRuleDialog({ api, repoId, path, mode, onClose, onAdded }: {
  api: GitCrestApiClient;
  repoId: string;
  path: string;
  mode: IgnoreMode;
  onClose: () => void;
  /** The rule was written; the caller refreshes the status so the file moves to the ignored group. */
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const [target, setTarget] = useState<IgnoreTarget>("gitignore");
  const [rule, setRule] = useState<IgnoreRuleResponse>();
  const [error, setError] = useState<DisplayError>("");

  useEffect(() => {
    const controller = new AbortController();
    setRule(undefined);
    setError("");
    api.withSignal(controller.signal).previewIgnoreRule(repoId, path, mode, target)
      .then((value) => { if (!controller.signal.aborted) setRule(value); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, t("ign.previewFailed"))); });
    return () => controller.abort();
  }, [api, repoId, path, mode, target]);

  async function add() {
    setBusy(true);
    setError("");
    try {
      await api.addIgnoreRule(repoId, path, mode, target);
      onAdded();
    } catch (reason) {
      setError(errorMessage(reason, t("ign.addFailed")));
    } finally {
      setBusy(false);
    }
  }

  const titleKey = mode === "file" ? "ign.titleFile" : mode === "extension" ? "ign.titleExtension" : "ign.titleFolder";
  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="cloneDialog ignoreRuleDialog" role="dialog" aria-modal="true" aria-labelledby="ignore-rule-title" onKeyDown={onKeyDown}>
      <header className="taskCenterHeader">
        <div><h2 id="ignore-rule-title">{t(titleKey)}</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("common.close")}</button>
      </header>
      <div className="cloneFormBody">
        <p className="cloneHelp monoText">{path}</p>
        <fieldset className="identityScope">
          <legend>{t("ign.where")}</legend>
          <label><input type="radio" name="ignore-target" checked={target === "gitignore"} disabled={busy} onChange={() => setTarget("gitignore")} />{t("ign.shared")}</label>
          <label><input type="radio" name="ignore-target" checked={target === "exclude"} disabled={busy} onChange={() => setTarget("exclude")} />{t("ign.private")}</label>
        </fieldset>
        {rule && <div className="ignoreRulePreview" role="status">
          <span>{t("ign.lineAdded", { file: rule.file })}</span>
          <code>{rule.line}</code>
          {rule.alreadyPresent && <p className="cloneHelp">{t("ign.already")}</p>}
        </div>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
      </div>
      <footer className="cloneDialogActions">
        <button className="quietButton" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button className="primaryButton" type="button" disabled={busy || !rule} onClick={() => void add()}>{busy ? t("ign.adding") : t("ign.add")}</button>
      </footer>
    </section>
  </div>;
}
