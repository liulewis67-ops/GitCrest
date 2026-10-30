import { isAbsolute, relative, resolve, sep } from "node:path";

/** Editors GitCrest looks for. The first one found is used while the choice is "automatic". */
export const KNOWN_EDITORS = [
  { id: "vscode", name: "Visual Studio Code", macApp: "Visual Studio Code", linuxPrograms: ["code"], windowsPaths: ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe", "%ProgramFiles%\\Microsoft VS Code\\Code.exe"] },
  { id: "cursor", name: "Cursor", macApp: "Cursor", linuxPrograms: ["cursor"], windowsPaths: ["%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe"] },
  { id: "sublime", name: "Sublime Text", macApp: "Sublime Text", linuxPrograms: ["subl"], windowsPaths: ["%ProgramFiles%\\Sublime Text\\sublime_text.exe"] },
  { id: "notepadpp", name: "Notepad++", macApp: undefined, linuxPrograms: [] as string[], windowsPaths: ["%ProgramFiles%\\Notepad++\\notepad++.exe"] },
] as const;

export type KnownEditorId = (typeof KNOWN_EDITORS)[number]["id"];

export type EditorChoice =
  | { kind: "auto" }
  | { kind: "known"; id: KnownEditorId }
  /** One program, not a command line: the path is always passed to it as a single argument. */
  | { kind: "custom"; program: string };

export interface ExternalToolsConfig {
  editor: EditorChoice;
}

export const DEFAULT_EXTERNAL_TOOLS: ExternalToolsConfig = { editor: { kind: "auto" } };

export interface DetectedEditor {
  id: KnownEditorId;
  name: string;
}

/** What the main process can do on this machine; replaced in tests. */
export interface ExternalToolsEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  fileExists: (path: string) => boolean;
  /** The full path of a program found on PATH. */
  findOnPath: (program: string) => string | undefined;
  /** Starts a detached program without a shell; resolves with an error message when it could not start. */
  start: (program: string, args: string[], options: { cwd?: string }) => Promise<string | undefined>;
}

export type OpenResult =
  | { ok: true }
  | { ok: false; code: "noEditor" | "badEditor" | "badPath" | "startFailed" | "noTerminal"; message: string };

interface Launch {
  program: string;
  /** Arguments that come before the target path. */
  args: string[];
}

function expand(template: string, env: Record<string, string | undefined>): string | undefined {
  let missing = false;
  const value = template.replace(/%([A-Za-z]+)%/g, (_match, name: string) => {
    const found = env[name] ?? env[name.toUpperCase()];
    if (!found) missing = true;
    return found ?? "";
  });
  return missing ? undefined : value;
}

function launchForKnown(editor: (typeof KNOWN_EDITORS)[number], tools: ExternalToolsEnvironment): Launch | undefined {
  if (tools.platform === "darwin") {
    if (!editor.macApp) return undefined;
    // `open -a` finds an installed app by name; check the usual folder so a missing app is not "found".
    return tools.fileExists(`/Applications/${editor.macApp}.app`) ? { program: "open", args: ["-a", editor.macApp] } : undefined;
  }
  if (tools.platform === "win32") {
    for (const template of editor.windowsPaths) {
      const path = expand(template, tools.env);
      if (path && tools.fileExists(path)) return { program: path, args: [] };
    }
    return undefined;
  }
  for (const program of editor.linuxPrograms) {
    const found = tools.findOnPath(program);
    if (found) return { program: found, args: [] };
  }
  return undefined;
}

export function detectEditors(tools: ExternalToolsEnvironment): DetectedEditor[] {
  return KNOWN_EDITORS.filter((editor) => launchForKnown(editor, tools)).map(({ id, name }) => ({ id, name }));
}

/** A custom program must be a single existing program; Windows batch files need a shell, so they are refused. */
export function validateCustomProgram(program: string, tools: ExternalToolsEnvironment): string | undefined {
  if (!program || program.length > 1024 || /[\0\r\n]/.test(program)) return "Enter the name or full path of one program.";
  if (tools.platform === "win32" && /\.(cmd|bat)$/i.test(program)) return "Batch files cannot be started safely. Choose the program's .exe file.";
  if (isAbsolute(program)) return tools.fileExists(program) ? undefined : "That program does not exist.";
  if (/[\\/\s]/.test(program)) return "Use a program name on the PATH, or its full path.";
  return tools.findOnPath(program) ? undefined : "That program was not found on the PATH.";
}

function resolveEditor(config: ExternalToolsConfig, tools: ExternalToolsEnvironment): Launch | OpenResult {
  const choice = config.editor;
  if (choice.kind === "custom") {
    const problem = validateCustomProgram(choice.program, tools);
    if (problem) return { ok: false, code: "badEditor", message: problem };
    return { program: isAbsolute(choice.program) ? choice.program : tools.findOnPath(choice.program) ?? choice.program, args: [] };
  }
  const candidates = choice.kind === "known" ? KNOWN_EDITORS.filter((editor) => editor.id === choice.id) : KNOWN_EDITORS;
  for (const editor of candidates) {
    const launch = launchForKnown(editor, tools);
    if (launch) return launch;
  }
  return { ok: false, code: "noEditor", message: choice.kind === "known" ? "The chosen editor was not found on this computer." : "No supported editor was found. Choose one in Settings." };
}

/** The target must be the repository folder itself or something inside it. */
export function resolveInsideRepository(repositoryPath: string, relativePath: string | undefined): string | undefined {
  if (!isAbsolute(repositoryPath)) return undefined;
  if (relativePath !== undefined && (relativePath.length > 4096 || /[\0\r\n]/.test(relativePath) || isAbsolute(relativePath))) return undefined;
  const root = resolve(repositoryPath);
  const target = relativePath ? resolve(root, relativePath) : root;
  const inside = relative(root, target);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  return target;
}

export async function openInEditor(target: string, config: ExternalToolsConfig, tools: ExternalToolsEnvironment): Promise<OpenResult> {
  const launch = resolveEditor(config, tools);
  if ("ok" in launch) return launch;
  const error = await tools.start(launch.program, [...launch.args, target], {});
  return error ? { ok: false, code: "startFailed", message: error } : { ok: true };
}

/** Terminals are started in the folder through the working directory, so the path is never part of a command line. */
export async function openInTerminal(directory: string, tools: ExternalToolsEnvironment): Promise<OpenResult> {
  const attempts: Array<{ program: string; args: string[] }> = [];
  if (tools.platform === "win32") {
    const windowsTerminal = tools.findOnPath("wt.exe");
    if (windowsTerminal) attempts.push({ program: windowsTerminal, args: [] });
    const system = expand("%SystemRoot%\\System32\\cmd.exe", tools.env);
    if (system && tools.fileExists(system)) attempts.push({ program: system, args: ["/d", "/c", "start", "", "cmd.exe", "/k"] });
  } else if (tools.platform === "darwin") {
    attempts.push({ program: "open", args: ["-a", "Terminal", directory] });
  } else {
    for (const program of ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty", "xterm"]) {
      const found = tools.findOnPath(program);
      if (found) attempts.push({ program: found, args: [] });
    }
  }
  if (attempts.length === 0) return { ok: false, code: "noTerminal", message: "No terminal program was found." };
  let lastError = "";
  for (const attempt of attempts) {
    const error = await tools.start(attempt.program, attempt.args, { cwd: directory });
    if (!error) return { ok: true };
    lastError = error;
  }
  return { ok: false, code: "startFailed", message: lastError };
}

/** A saved choice only counts when it has a known shape. */
export function parseExternalToolsConfig(value: unknown): ExternalToolsConfig {
  const editor = (value as { editor?: unknown } | null)?.editor as Record<string, unknown> | undefined;
  if (editor?.kind === "known" && KNOWN_EDITORS.some((known) => known.id === editor.id)) return { editor: { kind: "known", id: editor.id as KnownEditorId } };
  if (editor?.kind === "custom" && typeof editor.program === "string" && editor.program.length > 0 && editor.program.length <= 1024 && !/[\0\r\n]/.test(editor.program)) {
    return { editor: { kind: "custom", program: editor.program } };
  }
  return DEFAULT_EXTERNAL_TOOLS;
}
