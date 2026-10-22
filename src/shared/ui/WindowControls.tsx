import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

export interface WindowControlsBridge {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  subscribeToMaximized: (listener: (maximized: boolean) => void) => () => void;
}

interface WindowControlsProps {
  /** The window's controls from the desktop bridge; without them (macOS, a browser) nothing is drawn. */
  controls?: WindowControlsBridge;
}

// Minimize, maximize and close for frameless windows, drawn flush against the header's right edge.
export function WindowControls({ controls }: WindowControlsProps) {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let active = true;
    const unsubscribe = controls.subscribeToMaximized(setMaximized);
    void controls.isMaximized().then((value) => { if (active) setMaximized(value); }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [controls]);

  if (!controls) return null;
  const maximizeLabel = maximized ? t("window.restore") : t("window.maximize");

  return (
    <div className="windowControls">
      <button type="button" aria-label={t("window.minimize")} title={t("window.minimize")} onClick={() => void controls.minimize()}>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
      </button>
      <button type="button" aria-label={maximizeLabel} title={maximizeLabel} onClick={() => void controls.toggleMaximize()}>
        {maximized
          ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M.5 2.5h7v7h-7z" /><path d="M2.5 2.5v-2h7v7h-2" /></svg>
          : <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5h9v9h-9z" /></svg>}
      </button>
      <button type="button" className="windowClose" aria-label={t("window.close")} title={t("window.close")} onClick={() => void controls.close()}>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="m.5.5 9 9M9.5.5l-9 9" /></svg>
      </button>
    </div>
  );
}
