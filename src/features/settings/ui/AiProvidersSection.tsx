import { Button } from "../../../shared/ui/Button";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState, type FormEvent } from "react";
import type { AiApiFormat, AiSettingsResponse, GitCrestApiClient } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import {
  AI_API_FORMATS,
  API_FORMAT_PATHS,
  DEFAULT_BASE_URLS,
  changeApiFormat,
  draftFromSettings,
  maxOutputTokensError,
  newProviderDraft,
  providerInput,
  settingsRequest,
  type AiSettingsDraft,
  type ProviderDraft,
} from "../model/ai-providers";
import { PrivacyScopePreview } from "./PrivacyScopePreview";

type TestState = { busy?: boolean; message?: string; error?: DisplayError };

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export function AiProvidersSection({ api, repoId }: { api: GitCrestApiClient; repoId?: string }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AiSettingsResponse>();
  const [draft, setDraft] = useState<AiSettingsDraft>({ activeProviderId: null, providers: [] });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [error, setError] = useState<DisplayError>("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api.withSignal(controller.signal).getAiSettings().then((value) => {
      if (controller.signal.aborted) return;
      setSettings(value);
      setDraft(draftFromSettings(value));
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(describeApiError(reason, t("aip.loadFailed")));
    });
    return () => controller.abort();
  }, [api]);

  function edit(next: AiSettingsDraft) {
    setDraft(next);
    setDirty(true);
    setNotice("");
  }

  function updateProvider(id: string, change: (provider: ProviderDraft) => ProviderDraft) {
    edit({ ...draft, providers: draft.providers.map((provider) => provider.id === id ? change(provider) : provider) });
    setTests(({ [id]: _cleared, ...rest }) => rest);
  }

  function addProvider() {
    const provider = newProviderDraft(draft.providers, t("aip.newName", { count: draft.providers.length + 1 }));
    // The first provider becomes active so the AI buttons can use it once saved; it never sends anything by itself.
    edit({ activeProviderId: draft.providers.length === 0 ? provider.id : draft.activeProviderId, providers: [...draft.providers, provider] });
  }

  function removeProvider(id: string) {
    edit({ activeProviderId: draft.activeProviderId === id ? null : draft.activeProviderId, providers: draft.providers.filter((provider) => provider.id !== id) });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await api.setAiSettings(settingsRequest(draft));
      setSettings(saved);
      setDraft(draftFromSettings(saved));
      setDirty(false);
      setNotice(t("aip.saved"));
    } catch (reason) {
      setError(describeApiError(reason, t("aip.saveFailed")));
    } finally { setBusy(false); }
  }

  function discard() {
    if (settings) setDraft(draftFromSettings(settings));
    setDirty(false); setError(""); setNotice(""); setTests({});
  }

  async function test(provider: ProviderDraft) {
    setTests((current) => ({ ...current, [provider.id]: { busy: true } }));
    try {
      const reply = await api.testAiProvider(providerInput(provider));
      setTests((current) => ({ ...current, [provider.id]: { message: t("aip.testOk", { model: reply.model, response: reply.response.trim() }) } }));
    } catch (reason) {
      setTests((current) => ({ ...current, [provider.id]: { error: describeApiError(reason, t("aip.testFailed")) } }));
    }
  }

  const invalid = draft.providers.some((provider) => !provider.name.trim() || !provider.baseUrl.trim() || !provider.model.trim() || maxOutputTokensError(provider.maxOutputTokens));

  return <section className="settingsSection" id="settings-section-ai" aria-labelledby="settings-ai-title">
    <div className="settingsSectionHeading">
      <h3 id="settings-ai-title" tabIndex={-1}>{t("settings.section.ai")}</h3>
      <Button type="button" variant="quiet" disabled={busy || !settings || draft.providers.length >= 20} onClick={addProvider}>{t("aip.add")}</Button>
    </div>
    <p className="settingsNotice">{t("aip.notice")}</p>
    <p className="settingsHint">{settings?.configPath ? t("aip.file", { path: settings.configPath }) : t("aip.fileUnknown")}</p>
    {!settings && !error && <p className="settingsNotice" role="status">{t("aip.loading")}</p>}
    {settings && <form className="aiProviderForm" onSubmit={save}>
      <div className="settingsCard">
        <div className="settingsRow">
          <div className="settingsRowText"><span id="ai-active-provider-title">{t("aip.active")}</span><p>{t("aip.activeHelp")}</p></div>
          <select className="aiActiveProvider" aria-labelledby="ai-active-provider-title" value={draft.activeProviderId ?? ""} disabled={busy} onChange={(event) => edit({ ...draft, activeProviderId: event.target.value || null })}>
            <option value="">{t("aip.off")}</option>
            {draft.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name.trim() || provider.id}</option>)}
          </select>
        </div>
      </div>
      {draft.providers.length === 0 && <p className="settingsNotice">{t("aip.empty")}</p>}
      {draft.providers.map((provider) => {
        const label = provider.name.trim() || provider.id;
        const local = isLoopbackUrl(provider.baseUrl.trim());
        const state = tests[provider.id];
        const tokensInvalid = maxOutputTokensError(provider.maxOutputTokens);
        return <fieldset key={provider.id} className="settingsCard aiProviderCard" aria-label={t("aip.cardAria", { name: label })} disabled={busy}>
          <div className="aiProviderCardHeader">
            <strong>{label}</strong>
            {draft.activeProviderId === provider.id && <span className="accountBadge selected">{t("aip.active")}</span>}
            {local && <span className="accountBadge">{t("aip.local")}</span>}
            <span className="composerHeaderSpacer" />
            <Button type="button" variant="danger" onClick={() => removeProvider(provider.id)}>{t("aip.remove")}</Button>
          </div>
          <div className="settingsFieldGrid">
            <label>{t("aip.name")}<input value={provider.name} maxLength={100} onChange={(event) => updateProvider(provider.id, (current) => ({ ...current, name: event.target.value }))} /></label>
            <label>{t("aip.format")}<select value={provider.apiFormat} onChange={(event) => updateProvider(provider.id, (current) => changeApiFormat(current, event.target.value as AiApiFormat))}>
              {AI_API_FORMATS.map((format) => <option key={format} value={format}>{t(`aip.format.${format}`)}</option>)}
            </select></label>
            <label className="aiProviderWide">{t("aip.baseUrl")}<input value={provider.baseUrl} placeholder={DEFAULT_BASE_URLS[provider.apiFormat]} autoComplete="url" spellCheck={false} onChange={(event) => updateProvider(provider.id, (current) => ({ ...current, baseUrl: event.target.value }))} />
              <span className="settingsHint">{t("aip.baseUrlHelp", { url: `${(provider.baseUrl.trim() || DEFAULT_BASE_URLS[provider.apiFormat]).replace(/\/+$/, "")}${API_FORMAT_PATHS[provider.apiFormat]}` })}</span>
            </label>
            <label>{t("aip.model")}<input value={provider.model} maxLength={255} spellCheck={false} onChange={(event) => updateProvider(provider.id, (current) => ({ ...current, model: event.target.value }))} /></label>
            <label>{t("aip.maxTokens")}<input value={provider.maxOutputTokens} inputMode="numeric" aria-invalid={tokensInvalid || undefined} onChange={(event) => updateProvider(provider.id, (current) => ({ ...current, maxOutputTokens: event.target.value }))} />
              <span className={tokensInvalid ? "fieldError" : "settingsHint"}>{tokensInvalid ? t("aip.maxTokensInvalid") : t("aip.maxTokensHelp")}</span>
            </label>
            <label className="aiProviderWide">{t("aip.apiKey")}<input type="password" value={provider.apiKey} autoComplete="new-password" spellCheck={false} placeholder={provider.hasApiKey && !provider.removeKey ? t("aip.keySavedPlaceholder") : local ? t("aip.keyOptional") : ""} onChange={(event) => updateProvider(provider.id, (current) => ({ ...current, apiKey: event.target.value, removeKey: false }))} /></label>
          </div>
          {provider.hasApiKey && <label className="disabledCheck"><input type="checkbox" checked={provider.removeKey} onChange={(event) => updateProvider(provider.id, (current) => ({ ...current, removeKey: event.target.checked, apiKey: event.target.checked ? "" : current.apiKey }))} /> {t("aip.removeKey")}</label>}
          <div className="settingsActions">
            <Button type="button" variant="secondary" disabled={state?.busy || !provider.baseUrl.trim() || !provider.model.trim() || tokensInvalid} title={t("aip.testHelp")} onClick={() => void test(provider)}>{state?.busy ? t("aip.testing") : t("aip.test")}</Button>
            {state?.message && <span className="settingsNotice" role="status">{state.message}</span>}
          </div>
          {state?.error && <p className="formError" role="alert"><ErrorMessage error={state.error} /></p>}
        </fieldset>;
      })}
      <div className="settingsActions">
        <Button variant="primary" type="submit" disabled={busy || !dirty || invalid}>{busy ? t("aip.saving") : t("aip.save")}</Button>
        {dirty && <Button variant="secondary" type="button" disabled={busy} onClick={discard}>{t("aip.discard")}</Button>}
        {dirty && <span className="settingsHint">{t("aip.unsaved")}</span>}
      </div>
    </form>}
    {error && <p className="formError" role="alert"><ErrorMessage error={error} /></p>}
    {notice && <p className="settingsNotice" role="status">{notice}</p>}
    <PrivacyScopePreview api={api} repoId={repoId} settings={settings} />
  </section>;
}
