// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXTERNAL_TOOLS,
  detectEditors,
  openInEditor,
  openInTerminal,
  parseExternalToolsConfig,
  resolveInsideRepository,
  validateCustomProgram,
  type ExternalToolsEnvironment,
} from "../../electron/main/external-tools";

function environment(overrides: Partial<ExternalToolsEnvironment> & { files?: string[]; onPath?: Record<string, string> } = {}) {
  const { files = [], onPath = {}, ...rest } = overrides;
  const start = vi.fn<ExternalToolsEnvironment["start"]>().mockResolvedValue(undefined);
  const tools: ExternalToolsEnvironment = {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local", ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    fileExists: (path) => files.includes(path),
    findOnPath: (program) => onPath[program],
    start,
    ...rest,
  };
  return { tools, start };
}

const CODE = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";

describe("editor detection", () => {
  it("finds the editors installed in their usual Windows folders", () => {
    const { tools } = environment({ files: [CODE, "C:\\Program Files\\Notepad++\\notepad++.exe"] });
    expect(detectEditors(tools).map((editor) => editor.id)).toEqual(["vscode", "notepadpp"]);
  });

  it("finds macOS apps by their application folder and Linux editors on the PATH", () => {
    expect(detectEditors(environment({ platform: "darwin", files: ["/Applications/Cursor.app"] }).tools).map((editor) => editor.id)).toEqual(["cursor"]);
    expect(detectEditors(environment({ platform: "linux", onPath: { code: "/usr/bin/code", subl: "/usr/bin/subl" } }).tools).map((editor) => editor.id)).toEqual(["vscode", "sublime"]);
  });

  it("finds nothing on a machine without them", () => {
    expect(detectEditors(environment().tools)).toEqual([]);
  });
});

describe("opening in an editor", () => {
  it("passes the path as one argument, without a shell", async () => {
    const { tools, start } = environment({ files: [CODE] });
    const path = "C:\\work\\my repo & more\\src\\a.ts";
    await expect(openInEditor(path, DEFAULT_EXTERNAL_TOOLS, tools)).resolves.toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith(CODE, [path], {});
  });

  it("uses `open -a` on macOS", async () => {
    const { tools, start } = environment({ platform: "darwin", files: ["/Applications/Visual Studio Code.app"] });
    await openInEditor("/Users/ada/repo", DEFAULT_EXTERNAL_TOOLS, tools);
    expect(start).toHaveBeenCalledWith("open", ["-a", "Visual Studio Code", "/Users/ada/repo"], {});
  });

  it("explains how to fix a missing editor", async () => {
    const result = await openInEditor("C:\\work", DEFAULT_EXTERNAL_TOOLS, environment().tools);
    expect(result).toMatchObject({ ok: false, code: "noEditor" });
  });

  it("reports a chosen editor that is gone, and a program that fails to start", async () => {
    const gone = await openInEditor("C:\\work", { editor: { kind: "known", id: "sublime" } }, environment({ files: [CODE] }).tools);
    expect(gone).toMatchObject({ ok: false, code: "noEditor" });
    const { tools, start } = environment({ files: [CODE] });
    start.mockResolvedValueOnce("spawn failed");
    await expect(openInEditor("C:\\work", DEFAULT_EXTERNAL_TOOLS, tools)).resolves.toEqual({ ok: false, code: "startFailed", message: "spawn failed" });
  });

  it("starts a custom program by its full path or its PATH name", async () => {
    const full = environment({ files: ["C:\\tools\\edit.exe"] });
    await openInEditor("C:\\work", { editor: { kind: "custom", program: "C:\\tools\\edit.exe" } }, full.tools);
    expect(full.start).toHaveBeenCalledWith("C:\\tools\\edit.exe", ["C:\\work"], {});
    const named = environment({ platform: "linux", onPath: { micro: "/usr/bin/micro" } });
    await openInEditor("/work", { editor: { kind: "custom", program: "micro" } }, named.tools);
    expect(named.start).toHaveBeenCalledWith("/usr/bin/micro", ["/work"], {});
  });
});

describe("custom program validation", () => {
  const { tools } = environment({ files: ["C:\\tools\\edit.exe", "C:\\tools\\edit.cmd"], onPath: { micro: "C:\\bin\\micro.exe" } });

  it("accepts an existing program and a name on the PATH", () => {
    expect(validateCustomProgram("C:\\tools\\edit.exe", tools)).toBeUndefined();
    expect(validateCustomProgram("micro", tools)).toBeUndefined();
  });

  it("refuses command lines, batch files and missing programs", () => {
    expect(validateCustomProgram("micro --wait", tools)).toBeTruthy();
    expect(validateCustomProgram("C:\\tools\\edit.cmd", tools)).toMatch(/Batch files/);
    expect(validateCustomProgram("C:\\tools\\missing.exe", tools)).toBeTruthy();
    expect(validateCustomProgram("nothere", tools)).toBeTruthy();
    expect(validateCustomProgram("a\nb", tools)).toBeTruthy();
    expect(validateCustomProgram("", tools)).toBeTruthy();
  });
});

describe("opening a terminal", () => {
  it("starts it in the folder through the working directory, not the command line", async () => {
    const { tools, start } = environment({ onPath: { "wt.exe": "C:\\wt\\wt.exe" } });
    await expect(openInTerminal("C:\\work\\a & b", tools)).resolves.toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith("C:\\wt\\wt.exe", [], { cwd: "C:\\work\\a & b" });
  });

  it("falls back to the next terminal when one cannot start", async () => {
    const { tools, start } = environment({ platform: "linux", onPath: { gnome_unused: "x", "gnome-terminal": "/usr/bin/gnome-terminal", xterm: "/usr/bin/xterm" } });
    start.mockResolvedValueOnce("no display").mockResolvedValueOnce(undefined);
    await expect(openInTerminal("/work", tools)).resolves.toEqual({ ok: true });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith("/usr/bin/xterm", [], { cwd: "/work" });
  });

  it("reports when no terminal exists", async () => {
    expect(await openInTerminal("/work", environment({ platform: "linux" }).tools)).toMatchObject({ ok: false, code: "noTerminal" });
  });

  it("uses Terminal on macOS", async () => {
    const { tools, start } = environment({ platform: "darwin" });
    await openInTerminal("/Users/ada/repo", tools);
    expect(start).toHaveBeenCalledWith("open", ["-a", "Terminal", "/Users/ada/repo"], { cwd: "/Users/ada/repo" });
  });
});

describe("paths inside a repository", () => {
  const root = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";

  it("accepts the folder itself and files inside it", () => {
    expect(resolveInsideRepository(root, undefined)).toBe(root);
    expect(resolveInsideRepository(root, "src/a.ts")).toMatch(/src[\\/]a\.ts$/);
  });

  it("refuses anything that leaves the repository or is not a plain relative path", () => {
    // A drive path is only a drive path on Windows; elsewhere it is an ordinary name that stays inside the repository.
    const refused = ["../other", "src/../../other", "/etc/passwd", "a\nb", "a\0b", ...(process.platform === "win32" ? ["C:\\Windows"] : [])];
    for (const path of refused) {
      expect(resolveInsideRepository(root, path), path).toBeUndefined();
    }
    expect(resolveInsideRepository("relative/repo", undefined)).toBeUndefined();
  });
});

describe("saved choice", () => {
  it("keeps a known shape and falls back to automatic for anything else", () => {
    expect(parseExternalToolsConfig({ editor: { kind: "known", id: "cursor" } })).toEqual({ editor: { kind: "known", id: "cursor" } });
    expect(parseExternalToolsConfig({ editor: { kind: "custom", program: "micro" } })).toEqual({ editor: { kind: "custom", program: "micro" } });
    for (const bad of [null, {}, { editor: { kind: "known", id: "unknown" } }, { editor: { kind: "custom", program: "" } }, { editor: { kind: "custom", program: "a\nb" } }, "text"]) {
      expect(parseExternalToolsConfig(bad)).toEqual(DEFAULT_EXTERNAL_TOOLS);
    }
  });
});
