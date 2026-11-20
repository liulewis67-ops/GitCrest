import type { ReactNode } from "react";
import { dismissHint, useHintVisible, type HintId } from "../hints/hints-store";
import { useI18n } from "../i18n";

/**
 * A short note shown once on first use of an area. It is a note, not an alert: assistive technology
 * reads it in place without interrupting, and "Got it" keeps it away until it is reset in Settings.
 */
export function InlineHint({ id, title, label, children }: { id: HintId; title?: string; label?: string; children: ReactNode }) {
  const { t } = useI18n();
  const visible = useHintVisible(id);
  if (!visible) return null;
  return <aside className="inlineHint" role="note" aria-label={label ?? title ?? t("hint.aria")}>
    <details className="inlineHintText flowDisclosure"><summary>{id === "changes" ? t("ux.stagingHelp") : title ?? label ?? t("hint.aria")}</summary><div className="inlineHintCopy flowDisclosureBody">{children}</div></details>
    <button className="textButton" type="button" onClick={() => dismissHint(id)}>{t("hint.gotIt")}</button>
  </aside>;
}
