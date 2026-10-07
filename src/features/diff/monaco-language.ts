const MONACO_LANGUAGES: Record<string, string> = {
  c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", go: "go", h: "cpp", hpp: "cpp",
  html: "html", java: "java", js: "javascript", jsx: "javascript", json: "json", md: "markdown",
  mjs: "javascript", py: "python", rs: "rust", scss: "scss", sh: "shell", sql: "sql", toml: "ini",
  ts: "typescript", tsx: "typescript", xml: "xml", yml: "yaml", yaml: "yaml",
};

export interface MonacoLanguage {
  id: string;
  supported: boolean;
}

export function monacoLanguageForPath(path: string): MonacoLanguage {
  const pathParts = path.split(/[\\/]/);
  const fileName = pathParts[pathParts.length - 1] ?? "";
  const fileParts = fileName.split(".");
  const extension = fileParts.length > 1 ? fileParts[fileParts.length - 1]?.toLowerCase() ?? "" : "";
  const id = MONACO_LANGUAGES[extension];
  return id ? { id, supported: true } : { id: "plaintext", supported: false };
}
