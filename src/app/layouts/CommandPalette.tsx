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
  shortcuts,
  isMacPlatform,
  query,
  onQueryChange,
  onClose,
}: CommandPaletteProps) {
  const { t } = useI18n();

  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  useEffect(() => {
    if (open) {
      setRecentIds(readRecentCommands());
      setShowUnavailable(false);
      setSelectedId(undefined);
    }
  }, [open]);
  if (!open) return null;

  const searching = query.trim().length > 0;
  const matches = rankCommands(commands, query);
  const unavailable = matches.filter((command) => !command.available);
  const filteredCommands = showUnavailable ? matches : matches.filter((command) => command.available);
  // A search shows one ranked list; without one, the last commands used lead and the rest follow in groups.
  const recent = searching ? [] : recentCommands(commands.filter((command) => command.available), recentIds);
  const activeId = selectedId ?? recent[0]?.id ?? filteredCommands[0]?.id;
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
            onChange={(event) => { setSelectedId(undefined); onQueryChange(event.target.value); }}
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
                  aria-label={command.label}
                  aria-disabled={!command.available || undefined}
                  aria-describedby={activeId === command.id ? `command-detail-${command.id}` : undefined}
                  onFocus={() => setSelectedId(command.id)}
                  onMouseEnter={() => setSelectedId(command.id)}
                  aria-keyshortcuts={command.shortcut ? ariaShortcut(shortcuts[command.shortcut], isMacPlatform) : undefined}
                  onClick={() => {
                    if (!command.available) return;
                    setRecentIds(rememberRecentCommand(command.id, recentIds));
                    command.run();
                    onClose();
                  }}
                >
                  <span className="commandItemMain"><strong>{command.label}</strong>{activeId === command.id && <small id={`command-detail-${command.id}`}>{!command.available && command.unavailableReason ? command.unavailableReason : command.detail}</small>}</span>
                  {command.available
                    ? command.shortcut && <kbd>{displayShortcut(shortcuts[command.shortcut], isMacPlatform)}</kbd>
                    : <span className="unavailableTag">{t("palette.unavailable")}</span>}
                </button>
              ))}
            </div>
          ))}
          {unavailable.length > 0 && <button className="commandItem commandUnavailableToggle" type="button" aria-expanded={showUnavailable} onFocus={() => setSelectedId("unavailable")} onClick={() => setShowUnavailable((value) => !value)}>{t(unavailable.every((command) => command.requiresRepository) ? "palette.requiresRepository" : "palette.unavailableCount", { count: unavailable.length })}</button>}
          {matches.length === 0 && <p className="noCommands">{t("palette.noMatch", { query })}</p>}
        </div>
        <div className="paletteFooter"><span>{t("palette.navigate")}</span><span>{t("palette.run")}</span><span>{t("palette.close")}</span></div>
      </Dialog>
  );
}
