/** Suggests a sibling folder named `<repo>-<branch>` for a new worktree. */
export function suggestWorktreePath(repositoryPath: string | undefined, branch: string) {
  if (!repositoryPath || !branch) return "";
  const separator = repositoryPath.includes("\\") ? "\\" : "/";
  const trimmed = repositoryPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return "";
  return `${trimmed.slice(0, cut)}${separator}${trimmed.slice(cut + 1)}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

/** Joins a folder chosen in the picker with the leaf of the suggested worktree path. */
export function worktreePathInParent(parent: string, suggested: string) {
  const leaf = suggested.split(/[\\/]/).pop() || "worktree";
  return `${parent.replace(/[\\/]+$/, "")}${parent.includes("\\") ? "\\" : "/"}${leaf}`;
}
