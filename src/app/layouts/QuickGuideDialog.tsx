import { useState } from "react";
import { displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n } from "../../shared/i18n";
import { Button } from "../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../shared/ui/Dialog";

const topics = [
  { id: "review", shortcut: "viewChanges" },
  { id: "commit", shortcut: "commit" },
  { id: "sync", shortcut: "push" },
  { id: "branches", shortcut: "branchSwitcher" },
  { id: "recovery", shortcut: "commandPalette" },
] as const;

/** Task-level help stays local and uses the same current bindings as the workbench. */
export function QuickGuideDialog({ shortcuts, isMacPlatform, onClose }: { shortcuts: ShortcutPreferences; isMacPlatform: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const matches = topics.filter(({ id }) => `${t(`guide.${id}.title`)} ${t(`guide.${id}.body`)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Dialog className="taskCenter quickGuide" aria-labelledby="quick-guide-title" closeLabel={t("guide.close")} onClose={onClose}>
    <DialogHeader><h2 id="quick-guide-title">{t("guide.title")}</h2></DialogHeader>
    <div className="quickGuideBody">
      <label className="shortcutSearch">{t("guide.search")}<input type="search" data-dialog-initial-focus value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {matches.map(({ id, shortcut }) => <section key={id} className="quickGuideTopic"><h3>{t(`guide.${id}.title`)}</h3><p>{t(`guide.${id}.body`)}</p><kbd>{displayShortcut(shortcuts[shortcut], isMacPlatform)}</kbd></section>)}
      {matches.length === 0 && <p role="status">{t("guide.noMatches")}</p>}
    </div>
    <DialogFooter><Button onClick={onClose}>{t("common.close")}</Button></DialogFooter>
  </Dialog>;
}
