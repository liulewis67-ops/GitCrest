import { useSyncExternalStore } from "react";
import { getGitCrestBridge, type GitCrestBridge, type GitCrestLanguagePluginEntry } from "../../../api/bridge";
import { BUILTIN_LANGUAGES, type LanguageDefinition } from "./builtin-languages";
import { validateLanguageSyntax, validateStructureRules } from "./structure-rules";

export interface LanguagePluginStatus {
  folder: string;
  id?: string;
  name?: string;
  version?: string;
  extensions: string[];
  fileNames: string[];
  state: "ready" | "error";
  error?: string;
  /** Extensions and file names a built-in language already handles; the built-in one is used for them. */
  shadowed: string[];
}

export interface LanguageRegistrySnapshot {
  builtins: readonly LanguageDefinition[];
  plugins: readonly LanguageDefinition[];
  statuses: readonly LanguagePluginStatus[];
  /** Where plugin folders are read from; unknown outside the desktop app. */
  directory?: string;
  /** False when this window cannot read plugins at all, as in a browser preview. */
  pluginsAvailable: boolean;
  loading: boolean;
}

let snapshot: LanguageRegistrySnapshot = {
  builtins: BUILTIN_LANGUAGES,
  plugins: [],
  statuses: [],
  pluginsAvailable: false,
  loading: false,
};
let requested = false;
let reloadCount = 0;
const listeners = new Set<() => void>();

function publish(change: Partial<LanguageRegistrySnapshot>) {
  snapshot = { ...snapshot, ...change };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The current languages; components re-render when plugins finish loading or report a problem. */
export function useLanguageRegistry(): LanguageRegistrySnapshot {
  ensurePluginsRequested();
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function getLanguageRegistry(): LanguageRegistrySnapshot {
  return snapshot;
}

function fileParts(path: string): { fileName: string; extension: string } {
  const fileName = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const dot = fileName.lastIndexOf(".");
  return { fileName, extension: dot > 0 ? fileName.slice(dot + 1) : "" };
}

function matches(language: LanguageDefinition, fileName: string, extension: string): boolean {
  return Boolean(language.fileNames?.includes(fileName)) || (extension !== "" && language.extensions.includes(extension));
}

/** The language of a file: built-in languages first, then plugins in folder order. */
export function languageForPath(path: string): LanguageDefinition | undefined {
  ensurePluginsRequested();
  const { fileName, extension } = fileParts(path);
  return snapshot.builtins.find((language) => matches(language, fileName, extension))
    ?? snapshot.plugins.find((language) => matches(language, fileName, extension));
}

export function languageById(id: string): LanguageDefinition | undefined {
  return snapshot.builtins.find((language) => language.id === id) ?? snapshot.plugins.find((language) => language.id === id);
}

function ensurePluginsRequested() {
  if (requested) return;
  requested = true;
  const bridge = getGitCrestBridge();
  if (bridge?.listLanguagePlugins && bridge.readLanguagePluginGrammar) void loadPlugins(bridge);
}

/** Reads the plugin folder again, e.g. after the user added or edited a plugin. */
export async function reloadLanguagePlugins(): Promise<void> {
  requested = true;
  const bridge = getGitCrestBridge();
  if (bridge?.listLanguagePlugins && bridge.readLanguagePluginGrammar) await loadPlugins(bridge);
}

async function loadPlugins(bridge: GitCrestBridge) {
  publish({ loading: true, pluginsAvailable: true });
  try {
    const listing = await bridge.listLanguagePlugins!();
    reloadCount += 1;
    const { plugins, statuses } = definePlugins(listing.plugins, (id) => bridge.readLanguagePluginGrammar!(id), reloadCount);
    publish({ plugins, statuses, directory: listing.directory, loading: false });
  } catch (error) {
    publish({
      plugins: [],
      statuses: [{ folder: "", extensions: [], fileNames: [], shadowed: [], state: "error", error: error instanceof Error ? error.message : String(error) }],
      loading: false,
    });
  }
}

/** Turns checked plugin manifests into languages, validating their structure rules. */
export function definePlugins(
  entries: readonly GitCrestLanguagePluginEntry[],
  readGrammar: (id: string) => Promise<Uint8Array>,
  generation: number,
): { plugins: LanguageDefinition[]; statuses: LanguagePluginStatus[] } {
  const plugins: LanguageDefinition[] = [];
  const statuses: LanguagePluginStatus[] = [];
  for (const entry of entries) {
    const manifest = entry.manifest;
    const base = { folder: entry.folder, extensions: manifest?.extensions ?? [], fileNames: manifest?.fileNames ?? [], shadowed: [] as string[] };
    if (!manifest) {
      statuses.push({ ...base, state: "error", error: entry.error ?? "The plugin could not be read." });
      continue;
    }
    const identity = { id: manifest.id, name: manifest.name, version: manifest.version };
    if (BUILTIN_LANGUAGES.some((language) => language.id === manifest.id)) {
      statuses.push({ ...base, ...identity, state: "error", error: `"${manifest.id}" is the id of a built-in language.` });
      continue;
    }
    const rules = validateStructureRules(manifest.structure);
    if (!rules.ok) {
      statuses.push({ ...base, ...identity, state: "error", error: rules.error });
      continue;
    }
    const syntax = manifest.syntax === undefined ? undefined : validateLanguageSyntax(manifest.syntax);
    if (syntax && !syntax.ok) {
      statuses.push({ ...base, ...identity, state: "error", error: syntax.error });
      continue;
    }
    const shadowed = [
      ...manifest.extensions.filter((extension) => BUILTIN_LANGUAGES.some((language) => language.extensions.includes(extension))).map((extension) => `.${extension}`),
      ...manifest.fileNames.filter((fileName) => BUILTIN_LANGUAGES.some((language) => language.fileNames?.includes(fileName))),
    ];
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      extensions: manifest.extensions,
      fileNames: manifest.fileNames,
      monacoLanguage: manifest.monacoLanguage ?? "plaintext",
      grammar: { bytes: () => readGrammar(manifest.id) },
      structure: { type: "rules", rules: rules.rules },
      source: "plugin",
      version: `${manifest.version}#${generation}`,
      ...(syntax?.ok ? { syntax: syntax.syntax } : {}),
    });
    statuses.push({ ...base, ...identity, state: "ready", shadowed });
  }
  return { plugins, statuses };
}

/** Records that a plugin's grammar failed to load, so Settings can say why its files show no structure. */
export function reportLanguageFailure(id: string, message: string) {
  const status = snapshot.statuses.find((entry) => entry.id === id);
  if (!status || (status.state === "error" && status.error === message)) return;
  publish({
    plugins: snapshot.plugins.filter((language) => language.id !== id),
    statuses: snapshot.statuses.map((entry) => entry.id === id ? { ...entry, state: "error", error: message } : entry),
  });
}

/** Replaces the plugin list directly; for tests. */
export function setLanguagePluginsForTesting(plugins: LanguageDefinition[], statuses: LanguagePluginStatus[] = []) {
  requested = true;
  publish({ plugins, statuses, pluginsAvailable: true, loading: false });
}
