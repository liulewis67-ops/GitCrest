import { Dialog, DialogHeader } from "../../shared/ui/Dialog";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n, type MessageKey } from "../../shared/i18n";
import type { CommandGroup, CommandPaletteCommand } from "../commands/palette-commands";
import { rankCommands, readRecentCommands, recentCommands, rememberRecentCommand } from "../commands/palette-search";
import { useEffect, useState } from "react";

export type { CommandPaletteCommand };

const GROUP_ORDER: CommandGroup[] = ["navigate", "repository", "changes", "branches", "commits", "remote", "view", "app"];

interface CommandPaletteProps {
  open: boolean;
  context: string;
  commands: CommandPaletteCommand[];
  navigationShortcut: string;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}

export function CommandPalette({
  open,
  context,
  commands,
  navigationShortcut,
  shortcuts,
  isMacPlatform,
  query,
  onQueryChange,
  onClose,
}: CommandPaletteProps) {
  const { t } = useI18n();

  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    if (open) setRecentIds(readRecentCommands());
  }, [open]);
  if (!open) return null;

  const searching = query.trim().length > 0;
  const filteredCommands = rankCommands(commands, query);
  // A search shows one ranked list; without one, the last commands used lead and the rest follow in groups.
  const recent = searching ? [] : recentCommands(commands, recentIds);
  const recentSet = new Set(recent.map((command) => command.id));
  const groups: Array<{ group: CommandGroup | "recent" | "results"; items: CommandPaletteCommand[] }> = searching
    ? [{ group: "results", items: filteredCommands }]
    : [
      ...(recent.length > 0 ? [{ group: "recent" as const, items: recent }] : []),
      ...GROUP_ORDER
        .map((group) => ({ group, items: filteredCommands.filter((command) => command.group === group && !recentSet.has(command.id)) }))
        .filter(({ items }) => items.length > 0),
    ];

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".commandItem:not(:disabled)"));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Enter") {
      event.preventDefault();
      (current >= 0 ? items[current] : items[0]).click();
      return;
    }
    event.preventDefault();
    const next = event.key === "ArrowDown"
      ? (current + 1) % items.length
      : (current <= 0 ? items.length - 1 : current - 1);
    items[next].focus();
  }

  return (
    <Dialog className="commandPalette" role="dialog" aria-labelledby="palette-title" onKeyDown={handleKeyDown} onClose={onClose} busy={false}>
        <DialogHeader><h2 id="palette-title" >{t("palette.title")}</h2></DialogHeader>
        <div className="paletteSearch">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            data-dialog-initial-focus
            aria-label={t("palette.searchLabel")}
            placeholder={t("palette.placeholder")}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="paletteContext">{context}</div>
        <div className="commandList">
          {groups.map(({ group, items }) => (
            <div className="commandGroup" role="group" aria-label={t(`cmd.group.${group}` as MessageKey)} key={group}>
              {group !== "results" && <div className="commandGroupLabel" aria-hidden="true">{t(`cmd.group.${group}` as MessageKey)}</div>}
              {items.map((command) => (
                <button
                  key={command.id}
                  className="commandItem"
                  type="button"
                  disabled={!command.available}
                  aria-keyshortcuts={command.shortcut ? ariaShortcut(shortcuts[command.shortcut], isMacPlatform) : undefined}
                  onClick={() => {
                    setRecentIds(rememberRecentCommand(command.id, recentIds));
                    command.run();
                    onClose();
                  }}
                >
                  <span className="commandItemMain"><strong>{command.label}</strong><small>{!command.available && command.unavailableReason ? command.unavailableReason : command.detail}</small></span>
                  {command.available
                    ? <kbd>{command.id === "workspace" ? `${navigationShortcut} 2` : command.id === "welcome" ? `${navigationShortcut} 1` : command.shortcut ? displayShortcut(shortcuts[command.shortcut], isMacPlatform) : "↵"}</kbd>
                    : <span className="unavailableTag">{t("palette.unavailable")}</span>}
                </button>
              ))}
            </div>
          ))}
          {filteredCommands.length === 0 && <p className="noCommands">{t("palette.noMatch", { query })}</p>}
        </div>
        <div className="paletteFooter"><span>{t("palette.navigate")}</span><span>{t("palette.run")}</span><span>{t("palette.close")}</span></div>
      </Dialog>
  );
}
