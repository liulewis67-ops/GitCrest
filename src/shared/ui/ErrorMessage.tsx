import { useId, useState } from "react";
import { useI18n } from "../i18n";
import { errorText, type DisplayError } from "../i18n/api-errors";

/** Phrasing content so errors can be used in existing paragraphs, notices and dialog fields. */
export function ErrorMessage({ error }: { error: DisplayError | undefined | null }) {
  const { t } = useI18n();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  if (!error) return null;
  if (typeof error === "string") return <>{error}</>;
  return <span className="apiErrorMessage">
    <span>{errorText(error)}</span>
    {error.details && <>
      <button className="textButton apiErrorDetailsToggle" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>{t("apiError.details")}</button>
      <span id={id} className="apiErrorDetails" hidden={!expanded}>{error.details}</span>
    </>}
  </span>;
}
