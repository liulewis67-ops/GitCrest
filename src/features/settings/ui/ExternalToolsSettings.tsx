import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState, type FormEvent } from "react";
import { getGitCrestBridge, type GitCrestEditorChoice, type GitCrestExternalTools } from "../../../api/bridge";
import { useI18n } from "../../../shared/i18n";

const AUTO = "auto";
const CUSTOM = "custom";

/** Which program "Open in editor" starts: the first one found, a detected editor, or any program the user names. */
export function ExternalToolsSettings() {
  const { t } = useI18n();
  const bridge = getGitCrestBridge();
  const [tools, setTools] = useState<GitCrestExternalTools>();
  const [selection, setSelection] = useState(AUTO);
  const [program, setProgram] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<DisplayError>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    bridge?.getExternalTools?.().then((value) => {
      if (!active) return;
      setTools(value);
      setSelection(value.editor.kind === "known" ? value.editor.id : value.editor.kind === "custom" ? CUSTOM : AUTO);
      setProgram(value.editor.kind === "custom" ? value.editor.program : "");
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!bridge?.setExternalEditor) {
    return <p className="cloneHelp">{t("tools.desktopOnly")}</p>;
  }
  const setEditor = bridge.setExternalEditor;

  async function save(event: FormEvent) {
    event.preventDefault();
    const choice: GitCrestEditorChoice = selection === AUTO ? { kind: "auto" }
      : selection === CUSTOM ? { kind: "custom", program: program.trim() }
        : { kind: "known", id: selection };
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await setEditor(choice);
      if (result.ok) setMessage(t("tools.saved"));
      else setError(result.message);
    } catch {
      setError(t("tools.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <form className="identityEditor" onSubmit={(event) => void save(event)}>
    <label>{t("tools.editor")}
      <SearchableSelect value={selection} disabled={busy || !tools} onChange={(event) => { setSelection(event.target.value); setMessage(""); setError(""); }}>
        <option value={AUTO}>{tools && tools.detected.length > 0 ? t("tools.autoFound", { name: tools.detected[0].name }) : t("tools.autoNone")}</option>
        {tools?.detected.map((editor) => <option key={editor.id} value={editor.id}>{editor.name}</option>)}
        <option value={CUSTOM}>{t("tools.custom")}</option>
      </SearchableSelect>
    </label>
    {selection === CUSTOM && <label>{t("tools.program")}
      <input value={program} maxLength={1024} spellCheck={false} placeholder={t("tools.programPlaceholder")} disabled={busy} onChange={(event) => setProgram(event.target.value)} />
    </label>}
    {selection === CUSTOM && <p className="cloneHelp">{t("tools.programHelp")}</p>}
    {error && <p className="dialogError" role="alert"><ErrorMessage error={error} /></p>}
    {message && <p className="commitCopyStatus" role="status">{message}</p>}
    <div className="identityActions"><button className="secondaryButton" type="submit" disabled={busy || !tools || (selection === CUSTOM && !program.trim())}>{busy ? t("id.saving") : t("tools.save")}</button></div>
  </form>;
}
