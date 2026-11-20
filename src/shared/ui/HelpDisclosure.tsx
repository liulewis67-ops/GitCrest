import type { ReactNode } from "react";
import { useI18n } from "../i18n";

/** Optional explanation stays beside its control without competing with the task. */
export function HelpDisclosure({ summary, children }: { summary?: string; children: ReactNode }) {
  const { t } = useI18n();
  return <details className="flowDisclosure helpDisclosure"><summary>{summary ?? t("ux.details")}</summary><div className="flowDisclosureBody">{children}</div></details>;
}
