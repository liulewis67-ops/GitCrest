import { useDialogFocus } from "../../shared/hooks/use-dialog-focus";

export interface CommandPaletteCommand {
  id: string;
  label: string;
  detail: string;
  available: boolean;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  context: string;
  commands: CommandPaletteCommand[];
  navigationShortcut: string;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}

export function CommandPalette({
  open,
  context,
  commands,
  navigationShortcut,
  query,
  onQueryChange,
  onClose,
}: CommandPaletteProps) {
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, false, undefined, open);
  if (!open) return null;

  const filteredCommands = commands.filter((command) =>
    `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase()),
  );

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
        <h2 id="palette-title" className="srOnly">Command palette</h2>
        <div className="paletteSearch">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            data-dialog-initial-focus
            aria-label="Search commands"
            placeholder="Search commands…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="paletteContext">{context}</div>
        <div className="commandList">
          {filteredCommands.map((command) => (
            <button
              key={command.id}
              className="commandItem"
              type="button"
              disabled={!command.available}
              onClick={() => {
                command.run();
                onClose();
              }}
            >
              <span className="commandItemMain"><strong>{command.label}</strong><small>{command.detail}</small></span>
              {command.available
                ? <kbd>{command.id === "workspace" ? `${navigationShortcut} 2` : command.id === "welcome" ? `${navigationShortcut} 1` : "↵"}</kbd>
                : <span className="unavailableTag">Unavailable</span>}
            </button>
          ))}
          {filteredCommands.length === 0 && <p className="noCommands">No commands match “{query}”.</p>}
        </div>
        <div className="paletteFooter"><span>↑ ↓ Navigate</span><span>Enter Run command</span><span>Esc Close</span></div>
      </section>
    </div>
  );
}
