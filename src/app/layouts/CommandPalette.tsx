import { useDialogFocus } from "../../shared/hooks/use-dialog-focus";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n, type MessageKey } from "../../shared/i18n";
import type { CommandGroup, CommandPaletteCommand } from "../commands/palette-commands";

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
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, false, undefined, open);
  if (!open) return null;

  const filteredCommands = commands.filter((command) =>
    `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase()),
  );
  const groups = GROUP_ORDER
    .map((group) => ({ group, items: filteredCommands.filter((command) => command.group === group) }))
    .filter(({ items }) => items.length > 0);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    onKeyDown(event);
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
    <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className="commandPalette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="palette-title"
        onKeyDown={handleKeyDown}
      >
        <h2 id="palette-title" className="srOnly">{t("palette.title")}</h2>
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
              <div className="commandGroupLabel" aria-hidden="true">{t(`cmd.group.${group}` as MessageKey)}</div>
              {items.map((command) => (
                <button
                  key={command.id}
                  className="commandItem"
                  type="button"
                  disabled={!command.available}
                  aria-keyshortcuts={command.shortcut ? ariaShortcut(shortcuts[command.shortcut], isMacPlatform) : undefined}
                  onClick={() => {
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
      </section>
    </div>
  );
}
