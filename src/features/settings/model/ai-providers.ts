import type { AiApiFormat, AiProviderInput, AiProviderResponse, AiSettingsRequest, AiSettingsResponse } from "../../../api/client";

export const AI_API_FORMATS: readonly AiApiFormat[] = ["openAiChatCompletions", "openAiResponses", "anthropicMessages"];

export const DEFAULT_BASE_URLS: Record<AiApiFormat, string> = {
  openAiChatCompletions: "https://api.openai.com/v1",
  openAiResponses: "https://api.openai.com/v1",
  anthropicMessages: "https://api.anthropic.com/v1",
};

/** The path the core appends to the base URL for each format, shown so the endpoint is unambiguous. */
export const API_FORMAT_PATHS: Record<AiApiFormat, string> = {
  openAiChatCompletions: "/chat/completions",
  openAiResponses: "/responses",
  anthropicMessages: "/messages",
};

/** One provider as Settings edits it. The saved key is never loaded: `apiKey` holds only a newly typed key. */
export type ProviderDraft = {
  id: string;
  name: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  maxOutputTokens: string;
  apiKey: string;
  removeKey: boolean;
  hasApiKey: boolean;
};

export type AiSettingsDraft = { activeProviderId: string | null; providers: ProviderDraft[] };

export function draftFromProvider(provider: AiProviderResponse): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    model: provider.model,
    maxOutputTokens: provider.maxOutputTokens === null ? "" : String(provider.maxOutputTokens),
    apiKey: "",
    removeKey: false,
    hasApiKey: provider.hasApiKey,
  };
}

export function draftFromSettings(settings: AiSettingsResponse): AiSettingsDraft {
  return { activeProviderId: settings.activeProviderId, providers: settings.providers.map(draftFromProvider) };
}

export function newProviderDraft(existing: readonly ProviderDraft[], name: string): ProviderDraft {
  const ids = new Set(existing.map(({ id }) => id));
  let id = "";
  do id = `provider-${Math.random().toString(36).slice(2, 10)}`; while (ids.has(id));
  return { id, name, apiFormat: "openAiChatCompletions", baseUrl: DEFAULT_BASE_URLS.openAiChatCompletions, model: "", maxOutputTokens: "", apiKey: "", removeKey: false, hasApiKey: false };
}

/** Switching format also moves a still-default base URL to the new format's default. */
export function changeApiFormat(draft: ProviderDraft, apiFormat: AiApiFormat): ProviderDraft {
  const baseUrl = !draft.baseUrl.trim() || draft.baseUrl === DEFAULT_BASE_URLS[draft.apiFormat] ? DEFAULT_BASE_URLS[apiFormat] : draft.baseUrl;
  return { ...draft, apiFormat, baseUrl };
}

export function maxOutputTokensError(value: string): boolean {
  if (!value.trim()) return false;
  const number = Number(value);
  return !Number.isInteger(number) || number < 1 || number > 1_000_000;
}

export function providerInput(draft: ProviderDraft): AiProviderInput {
  const typedKey = draft.apiKey.trim();
  return {
    id: draft.id,
    name: draft.name.trim(),
    apiFormat: draft.apiFormat,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    maxOutputTokens: draft.maxOutputTokens.trim() ? Number(draft.maxOutputTokens) : null,
    // Leaving `apiKey` out keeps the key the core already has for this id.
    ...(typedKey ? { apiKey: typedKey } : draft.removeKey ? { apiKey: "" } : {}),
  };
}

export function settingsRequest(draft: AiSettingsDraft): AiSettingsRequest {
  return { activeProviderId: draft.activeProviderId, providers: draft.providers.map(providerInput) };
}

export function activeProvider(settings: AiSettingsResponse | undefined): AiProviderResponse | undefined {
  if (!settings?.activeProviderId) return undefined;
  return settings.providers.find(({ id }) => id === settings.activeProviderId);
}
