import { useI18n } from "../../../shared/i18n";
import type { DiffDocumentResponse } from "../../../api/client";

/** Explains a diff that has no text to compare, such as a binary file or a submodule. */
export function DiffStatusNotice({ status }: { status: DiffDocumentResponse["status"] }) {
  const { t } = useI18n();
  const descriptions: Record<DiffDocumentResponse["status"], string> = {
    text: t("sd.text"),
    binary: t("sd.binary"),
    empty: t("sd.empty"),
    conflicted: t("sd.conflicted"),
    ignored: t("sd.ignored"),
    symlink: t("sd.symlink"),
    submodule: t("sd.submodule"),
  };
  return <div className="diffSpecialState" role="status"><span className={`diffStateBadge diffState-${status}`}>{status}</span><p>{descriptions[status]}</p></div>;
}
