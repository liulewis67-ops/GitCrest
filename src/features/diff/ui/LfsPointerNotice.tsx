import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../shared/i18n";
import { formatLfsSize, type LfsPointer, type LfsPointerChange } from "../model/lfs-pointer";

export interface LfsAvailability {
  installed: boolean;
  version: string | null;
}

function describe(pointer: LfsPointer) {
  return `${pointer.oid.slice(0, 12)} · ${formatLfsSize(pointer.size)}`;
}

/** Explains a diff of a Git LFS pointer file: which object and size changed, and whether `git lfs` is there. */
export function LfsPointerNotice({ change, path, loadAvailability }: {
  change: LfsPointerChange;
  path: string;
  /** Asks the core whether Git LFS is installed; absent when it cannot be asked. */
  loadAvailability?: () => Promise<LfsAvailability>;
}) {
  const { t } = useI18n();
  const [availability, setAvailability] = useState<LfsAvailability>();
  // Callers pass a fresh function each render; ask once per notice, not once per render.
  const load = useRef(loadAvailability);
  load.current = loadAvailability;
  useEffect(() => {
    let active = true;
    load.current?.().then((value) => { if (active) setAvailability(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const summary = change.kind === "added" ? t("lfs.added", { value: describe(change.after!) })
    : change.kind === "removed" ? t("lfs.removed", { value: describe(change.before!) })
      : t("lfs.changed", { before: describe(change.before!), after: describe(change.after!) });
  return <div className="diffSpecialState lfsPointerNotice" role="status" aria-label={t("lfs.aria", { path })}>
    <span className="diffStateBadge">LFS</span>
    <p><strong>{summary}</strong></p>
    <p className="cloneHelp">{t("lfs.explain")}</p>
    {availability && <p className="cloneHelp">{availability.installed ? t("lfs.installed", { version: availability.version ?? "" }) : t("lfs.missing")}</p>}
  </div>;
}
