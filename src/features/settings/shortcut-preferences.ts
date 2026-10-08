export const SHORTCUT_PREFERENCES_KEY = "gitcrest-shortcuts-v1";

export const shortcutActions = [
  { id: "commandPalette", label: "Open command palette", defaultBinding: "Mod+K" },
  { id: "commit", label: "Commit staged changes", defaultBinding: "Mod+Enter" },
  { id: "commitAndPush", label: "Commit and push", defaultBinding: "Mod+Shift+Enter" },
  { id: "pull", label: "Open pull review", defaultBinding: "Mod+Shift+L" },
  { id: "rebase", label: "Interactive rebase", defaultBinding: "Mod+I" },
  { id: "branchSwitcher", label: "Switch branch", defaultBinding: "Mod+B" },
  { id: "aiCommitMessage", label: "Generate commit message", defaultBinding: "Mod+G" },
] as const;

export type ShortcutAction = (typeof shortcutActions)[number]["id"];
export type ShortcutPreferences = Record<ShortcutAction, string>;

export const defaultShortcutPreferences: ShortcutPreferences = Object.fromEntries(
  shortcutActions.map(({ id, defaultBinding }) => [id, defaultBinding]),
) as ShortcutPreferences;

const reservedBindings = new Set(["Mod+Q", "Mod+W", "Alt+F4", "Escape"]);

export function readShortcutPreferences(value: string | null): ShortcutPreferences {
  if (!value) return { ...defaultShortcutPreferences };
  try {
    const saved: unknown = JSON.parse(value);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return { ...defaultShortcutPreferences };
    const result = { ...defaultShortcutPreferences };
    for (const { id } of shortcutActions) {
      const binding = (saved as Record<string, unknown>)[id];
      if (typeof binding === "string" && !shortcutConflict(id, binding, result)) result[id] = binding;
    }
    return result;
  } catch {
    return { ...defaultShortcutPreferences };
  }
}

export function isValidBinding(binding: string): boolean {
  const parts = binding.split("+");
  if (parts.length < 2 || parts[0] !== "Mod") return false;
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(1, -1);
  const normalizedKey = key ? normalizeKey(key) : undefined;
  return Boolean(normalizedKey === key
    && modifiers.length <= 2
    && modifiers.every((part, index) => part === (index === 0 && modifiers.length === 2 ? "Alt" : "Shift"))
    && new Set(modifiers).size === modifiers.length);
}

export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (event.isComposing || event.key === "Process" || event.key === "Dead") return undefined;
  if (!event.ctrlKey && !event.metaKey) return undefined;
  if (event.ctrlKey && event.metaKey) return undefined;
  const key = normalizeKey(event.key);
  if (!key) return undefined;
  return ["Mod", ...(event.altKey ? ["Alt"] : []), ...(event.shiftKey ? ["Shift"] : []), key].join("+");
}

export function shortcutConflict(
  action: ShortcutAction,
  binding: string,
  preferences: ShortcutPreferences,
): string | undefined {
  if (!isValidBinding(binding)) return "Use a Ctrl/Cmd shortcut with a key.";
  if (reservedBindings.has(binding)) return "This shortcut is reserved by the operating system or window.";
  const otherAction = shortcutActions.find(({ id }) => id !== action && preferences[id] === binding);
  return otherAction ? `Already assigned to ${otherAction.label}.` : undefined;
}

export function matchesShortcut(event: KeyboardEvent, binding: string, isMac: boolean): boolean {
  if (event.isComposing || event.key === "Process" || !isValidBinding(binding)) return false;
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  if (!key || normalizeKey(event.key) !== key) return false;
  const wantsAlt = parts.includes("Alt");
  const wantsShift = parts.includes("Shift");
  const wantsMod = parts.includes("Mod");
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  const wrongModPressed = isMac ? event.ctrlKey : event.metaKey;
  return modPressed === wantsMod
    && wrongModPressed === false
    && event.altKey === wantsAlt
    && event.shiftKey === wantsShift;
}

export function displayShortcut(binding: string, isMac: boolean): string {
  const labels = binding.split("+").map((part) => {
    if (part === "Mod") return isMac ? "⌘" : "Ctrl";
    if (part === "Shift") return isMac ? "⇧" : "Shift";
    if (part === "Alt") return isMac ? "⌥" : "Alt";
    if (part === "Enter") return "↵";
    return part;
  });
  return isMac ? labels.join("") : labels.join("+");
}

export function ariaShortcut(binding: string, isMac: boolean): string {
  return binding.split("+").map((part) => {
    if (part === "Mod") return isMac ? "Meta" : "Control";
    return part;
  }).join("+");
}

function normalizeKey(key: string): string | undefined {
  if (key === "Enter") return "Enter";
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (["Escape", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown"].includes(key)) return key;
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return key;
  return undefined;
}
