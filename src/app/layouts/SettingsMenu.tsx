import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ariaShortcut, displayShortcut, THEME_CYCLE, useThemePreference, type ShortcutPreferences, type Theme } from "../../features/settings";
import { LOCALES, useI18n } from "../../shared/i18n";

const MENU_WIDTH = 304;

const THEME_ICON: Record<Theme, ReactNode> = {
  system: <><rect x="2" y="3" width="12" height="8.5" rx="1.25" /><path d="M6 13.75h4M8 11.5v2.25" /></>,
  light: <><circle cx="8" cy="8" r="2.75" /><path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64 3.58 3.58" /></>,
  dark: <path d="M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.5 4.5 0 0 0 6.85 6.85Z" />,
};

/**
 * The gear at the end of the titlebar: theme and language switch in place, and the full
 * Settings page is one more click (or its own shortcut) away.
 */
export function SettingsMenu({ shortcuts, isMacPlatform, onOpenSettings }: {
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  onOpenSettings: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useThemePreference();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = Boolean(position);

  useEffect(() => {
    if (!open) return;
    const close = () => setPosition(undefined);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    menuRef.current?.querySelector<HTMLButtonElement>("[aria-checked='true']")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setPosition(undefined);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    // Right-aligned under the gear, which sits at the far end of the titlebar.
    if (rect) setPosition({ top: rect.bottom + 6, left: Math.max(4, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 4)) });
  }

  function openSettings() {
    setPosition(undefined);
    onOpenSettings();
  }

  /** Up and Down move through every item, wrapping at the ends; Tab still leaves the menu. */
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  }

  return <>
    <button
      ref={buttonRef}
      className={`quietButton settingsButton${open ? " active" : ""}`}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={t("titlebar.settings")}
      aria-keyshortcuts={ariaShortcut(shortcuts.settings, isMacPlatform)}
      title={t("titlebar.settingsTitle", { shortcut: displayShortcut(shortcuts.settings, isMacPlatform) })}
      onClick={toggle}
    >
      <svg className="titlebarIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.86 1.75h2.28l.33 1.62c.4.15.77.36 1.1.62l1.57-.53 1.14 1.98-1.24 1.1a4.4 4.4 0 0 1 0 1.27l1.24 1.1-1.14 1.98-1.57-.53c-.33.26-.7.47-1.1.62l-.33 1.62H6.86l-.33-1.62a4.3 4.3 0 0 1-1.1-.62l-1.57.53-1.14-1.98 1.24-1.1a4.4 4.4 0 0 1 0-1.27l-1.24-1.1 1.14-1.98 1.57.53c.33-.26.7-.47 1.1-.62Z" /><circle cx="8" cy="8" r="1.9" /></svg>
    </button>
    {position && <div ref={menuRef} className="quickSettingsMenu" role="menu" aria-label={t("titlebar.quickSettings")} style={{ top: position.top, left: position.left, width: MENU_WIDTH }} onKeyDown={onMenuKeyDown}>
      <div className="quickSettingsGroup" role="group" aria-labelledby="quick-settings-theme">
        <span className="quickSettingsLabel" id="quick-settings-theme">{t("titlebar.theme")}</span>
        <div className="quickSettingsOptions three">
          {THEME_CYCLE.map((mode) => (
            <button key={mode} type="button" role="menuitemradio" aria-checked={theme === mode} className="quickSettingsOption" onClick={() => setTheme(mode)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">{THEME_ICON[mode]}</svg>
              <span>{t(`theme.${mode}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="quickSettingsGroup" role="group" aria-labelledby="quick-settings-language">
        <span className="quickSettingsLabel" id="quick-settings-language">{t("language.label")}</span>
        <div className="quickSettingsOptions">
          {LOCALES.map((code) => (
            <button key={code} type="button" role="menuitemradio" aria-checked={locale === code} className="quickSettingsOption" lang={code === "zh" ? "zh-CN" : "en"} onClick={() => setLocale(code)}>
              <span>{t(`language.${code}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <button className="quickSettingsLink" type="button" role="menuitem" onClick={openSettings}>
        <span>{t("titlebar.allSettings")}</span>
        <kbd>{displayShortcut(shortcuts.settings, isMacPlatform)}</kbd>
      </button>
    </div>}
  </>;
}
