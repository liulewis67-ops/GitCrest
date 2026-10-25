import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

/**
 * Language plugins: folders in the app's data directory that add code-aware diff support for a language.
 * Each holds a manifest and a tree-sitter grammar compiled to WebAssembly. The manifest's structure rules
 * are data that the renderer validates; nothing in a plugin is executed as JavaScript.
 */
export const LANGUAGE_PLUGIN_MANIFEST = "gitcrest-language.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_GRAMMAR_BYTES = 32 * 1024 * 1024;
const MAX_PLUGINS = 50;
const ID = /^[a-z][a-z0-9-]{1,39}$/;
const EXTENSION = /^[a-z0-9][a-z0-9_+-]{0,15}$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const GRAMMAR_FILE = /^[A-Za-z0-9._-]{1,96}\.wasm$/;
const MONACO_LANGUAGE = /^[a-z][a-z0-9-]{0,29}$/;

export interface LanguagePluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  extensions: string[];
  fileNames: string[];
  grammar: string;
  monacoLanguage?: string;
  /** Checked by the renderer against the structure-rule format. */
  structure: unknown;
  /** Optional comment markers and debug patterns, also checked by the renderer. */
  syntax?: unknown;
}

export interface LanguagePluginEntry {
  /** The plugin's folder name inside the plugin directory. */
  folder: string;
  manifest?: LanguagePluginManifest;
  error?: string;
}

export interface LanguagePluginListing {
  directory: string;
  plugins: LanguagePluginEntry[];
}

class ManifestError extends Error {}

function invalid(message: string): never {
  throw new ManifestError(message);
}

function readStrings(value: unknown, field: string, pattern: RegExp, max: number, lowerCase: boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) invalid(`"${field}" must be a list of at most ${max} entries.`);
  return value.map((item) => {
    const text = typeof item === "string" ? (lowerCase ? item.toLowerCase().replace(/^\./, "") : item) : "";
    if (!pattern.test(text)) invalid(`"${field}" has an invalid entry: ${JSON.stringify(item)}.`);
    return text;
  });
}

function readLabel(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    invalid(`"${field}" must be text of at most ${max} characters.`);
  }
  return value.trim();
}

/** Checks a parsed manifest's identity, files and size limits; the structure rules are checked later by the renderer. */
export function parseLanguagePluginManifest(value: unknown): LanguagePluginManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("The manifest must be a JSON object.");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) invalid('"schemaVersion" must be 1.');
  if (typeof raw.id !== "string" || !ID.test(raw.id)) invalid('"id" must be 2–40 lower-case letters, digits or hyphens, starting with a letter.');
  const extensions = readStrings(raw.extensions, "extensions", EXTENSION, 20, true);
  const fileNames = readStrings(raw.fileNames, "fileNames", FILE_NAME, 20, true);
  if (extensions.length + fileNames.length === 0) invalid('Give at least one entry in "extensions" or "fileNames".');
  if (typeof raw.grammar !== "string" || !GRAMMAR_FILE.test(raw.grammar)) invalid('"grammar" must be the name of a .wasm file in the plugin folder.');
  if (raw.monacoLanguage !== undefined && (typeof raw.monacoLanguage !== "string" || !MONACO_LANGUAGE.test(raw.monacoLanguage))) {
    invalid('"monacoLanguage" must be a Monaco language id such as "kotlin".');
  }
  if (typeof raw.structure !== "object" || raw.structure === null) invalid('"structure" must be an object of structure rules.');
  if (raw.syntax !== undefined && (typeof raw.syntax !== "object" || raw.syntax === null || Array.isArray(raw.syntax))) invalid('"syntax" must be an object.');
  return {
    ...(raw.syntax !== undefined ? { syntax: raw.syntax } : {}),
    schemaVersion: 1,
    id: raw.id,
    name: readLabel(raw.name, "name", 60),
    version: readLabel(raw.version, "version", 30),
    extensions,
    fileNames,
    grammar: raw.grammar,
    monacoLanguage: raw.monacoLanguage as string | undefined,
    structure: raw.structure,
  };
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function readPlugin(directory: string, folder: string): Promise<LanguagePluginEntry> {
  try {
    const pluginDirectory = await realpath(join(directory, folder));
    const manifestPath = join(pluginDirectory, LANGUAGE_PLUGIN_MANIFEST);
    const manifestStat = await stat(manifestPath).catch(() => invalid(`${LANGUAGE_PLUGIN_MANIFEST} is missing.`));
    if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) invalid(`${LANGUAGE_PLUGIN_MANIFEST} must be a file of at most 256 KB.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      invalid(`${LANGUAGE_PLUGIN_MANIFEST} is not valid JSON.`);
    }
    const manifest = parseLanguagePluginManifest(parsed);
    await grammarPath(pluginDirectory, manifest.grammar);
    return { folder, manifest };
  } catch (error) {
    return { folder, error: error instanceof ManifestError ? error.message : "The plugin folder could not be read." };
  }
}

/** The grammar file, resolved through links and required to stay inside its plugin folder. */
async function grammarPath(pluginDirectory: string, grammar: string): Promise<string> {
  const path = await realpath(join(pluginDirectory, grammar)).catch(() => invalid(`The grammar ${grammar} is missing.`));
  if (!isInside(pluginDirectory, path)) invalid(`The grammar ${grammar} must be inside the plugin folder.`);
  const grammarStat = await stat(path);
  if (!grammarStat.isFile() || grammarStat.size > MAX_GRAMMAR_BYTES) invalid(`The grammar ${grammar} must be a file of at most 32 MB.`);
  return path;
}

/** Lists the plugin folders; a broken plugin is reported with its reason instead of hiding the others. */
export async function listLanguagePlugins(directory: string): Promise<LanguagePluginListing> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const folders = entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PLUGINS);
  const plugins = await Promise.all(folders.map((folder) => readPlugin(directory, folder)));
  // The first folder, in name order, keeps an id; later duplicates are reported.
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const id = plugin.manifest?.id;
    if (!id) continue;
    if (seen.has(id)) {
      plugin.error = `Another plugin folder already uses the id "${id}".`;
      delete plugin.manifest;
    } else {
      seen.add(id);
    }
  }
  return { directory, plugins };
}

/** Reads the grammar of the plugin that currently owns `id`, checking its files again first. */
export async function readLanguagePluginGrammar(directory: string, id: unknown): Promise<Uint8Array> {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid language plugin id.");
  const { plugins } = await listLanguagePlugins(directory);
  const plugin = plugins.find((entry) => entry.manifest?.id === id);
  if (!plugin?.manifest) throw new Error(`The language plugin "${id}" is not available.`);
  const pluginDirectory = await realpath(join(directory, plugin.folder));
  const path = await grammarPath(pluginDirectory, plugin.manifest.grammar);
  return new Uint8Array(await readFile(path));
}
