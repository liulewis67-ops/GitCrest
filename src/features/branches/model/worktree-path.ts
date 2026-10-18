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
