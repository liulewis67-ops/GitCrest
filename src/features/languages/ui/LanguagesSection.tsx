import { useState } from "react";
import { getGitCrestBridge } from "../../../api/bridge";
import { useI18n } from "../../../shared/i18n";
import { reloadLanguagePlugins, useLanguageRegistry } from "../model/language-registry";

function fileTypes(extensions: readonly string[], fileNames: readonly string[] = []): string {
  return [...extensions.map((extension) => `.${extension}`), ...fileNames].join(" ");
}

/** Settings: the languages with code-aware diffs, and the language plugins read from the plugin folder. */
export function LanguagesSection() {
  const { t } = useI18n();
  const registry = useLanguageRegistry();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bridge = getGitCrestBridge();

  async function reload() {
    setBusy(true);
    setError("");
    try {
      await reloadLanguagePlugins();
      // Loading each grammar now shows an incompatible one here, instead of on the first diff that needs it.
      const { checkLanguage } = await import("../model/grammar-loader");
      const { getLanguageRegistry } = await import("../model/language-registry");
      await Promise.all(getLanguageRegistry().plugins.map((language) => checkLanguage(language)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openFolder() {
    setError("");
    try {
      await bridge?.openLanguagePluginFolder?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section className="settingsSection" id="settings-section-languages" aria-labelledby="settings-languages-title">
      <h3 id="settings-languages-title" tabIndex={-1}>{t("settings.section.languages")}</h3>
      <p className="settingsHint">{t("lang.intro")}</p>
      <div className="settingsCard">
        <ul className="languageList" aria-label={t("lang.builtinAria")}>
          {registry.builtins.map((language) => <li key={language.id}>
            <span className="languageName">{language.name}</span>
            <span className="languageFiles">{fileTypes(language.extensions, language.fileNames)}</span>
          </li>)}
        </ul>
      </div>

      <div className="settingsSectionHeading">
        <h4 id="settings-language-plugins-title">{t("lang.plugins")}</h4>
        {registry.pluginsAvailable && <div className="settingsActions">
          {bridge?.openLanguagePluginFolder && <button className="secondaryButton" type="button" onClick={() => void openFolder()}>{t("lang.openFolder")}</button>}
          <button className="secondaryButton" type="button" disabled={busy || registry.loading} onClick={() => void reload()}>{busy || registry.loading ? t("lang.reloading") : t("lang.reload")}</button>
        </div>}
      </div>
      <p className="settingsHint">{t("lang.pluginsIntro")}</p>
      <div className="settingsCard" aria-labelledby="settings-language-plugins-title">
        {!registry.pluginsAvailable && <p className="settingsHint">{t("lang.desktopOnly")}</p>}
        {registry.pluginsAvailable && registry.directory && <p className="settingsHint">{t("lang.folder")} <code className="languagePluginFolder">{registry.directory}</code></p>}
        {registry.pluginsAvailable && !registry.loading && registry.statuses.length === 0 && <p className="settingsHint">{t("lang.none")}</p>}
        {registry.statuses.length > 0 && <ul className="languageList plugins" aria-label={t("lang.plugins")}>
          {registry.statuses.map((status) => <li key={`${status.folder}:${status.id ?? ""}`}>
            <span className="languageName">{status.name ?? status.folder}{status.version && <small> {status.version}</small>}</span>
            <span className={`languageState ${status.state}`}>{status.state === "ready" ? t("lang.ready") : t("lang.failed")}</span>
            <span className="languageFiles">{fileTypes(status.extensions, status.fileNames)}</span>
            {status.error && <p className="languageError">{status.error}</p>}
            {status.shadowed.length > 0 && <p className="settingsHint">{t("lang.shadowed", { types: status.shadowed.join(" ") })}</p>}
          </li>)}
        </ul>}
        {error && <p className="formError" role="alert">{error}</p>}
      </div>
    </section>
  );
}
