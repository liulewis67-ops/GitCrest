const PARENT_KEY = "gitcrest.worktreeParent";

function readRememberedParent(): string | undefined {
  try {
    return window.localStorage.getItem(PARENT_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function parentOf(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "";
}

/** Remembers the folder a worktree was created in, so the next suggestion starts there. */
export function rememberWorktreeParent(worktreePath: string) {
  const parent = parentOf(worktreePath);
  if (!parent) return;
  try {
    window.localStorage.setItem(PARENT_KEY, parent);
  } catch {
    /* Storage can be unavailable; suggestions then fall back to the repository's parent folder. */
  }
}

/**
 * Suggests `<parent>/<repo>-<branch>` for a new worktree. The parent is the folder used for the last worktree
 * when there is one, otherwise the folder that contains the repository.
 */
export function suggestWorktreePath(repositoryPath: string | undefined, branch: string) {
  if (!repositoryPath || !branch) return "";
  const trimmed = repositoryPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return "";
  const parent = readRememberedParent() ?? trimmed.slice(0, cut);
  const separator = parent.includes("\\") || (!parent.includes("/") && repositoryPath.includes("\\")) ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${trimmed.slice(cut + 1)}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

/** Joins a folder chosen in the picker with the leaf of the suggested worktree path. */
export function worktreePathInParent(parent: string, suggested: string) {
  const leaf = suggested.split(/[\\/]/).pop() || "worktree";
  return `${parent.replace(/[\\/]+$/, "")}${parent.includes("\\") ? "\\" : "/"}${leaf}`;
}

/** True for Windows drive, UNC and POSIX absolute paths, the only folders a worktree can be created in. */
export function isAbsoluteFolder(path: string) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());
}

const COPY_KEY_PREFIX = "gitcrest.worktreeCopyFiles.";

/** The local files copied into this repository's previous worktree, to tick again next time. */
export function rememberedCopyFiles(repoId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COPY_KEY_PREFIX + repoId) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function rememberCopyFiles(repoId: string, files: string[]) {
  try {
    if (files.length === 0) window.localStorage.removeItem(COPY_KEY_PREFIX + repoId);
    else window.localStorage.setItem(COPY_KEY_PREFIX + repoId, JSON.stringify(files));
  } catch {
    /* Best effort; without storage the files are simply not pre-ticked. */
  }
}
