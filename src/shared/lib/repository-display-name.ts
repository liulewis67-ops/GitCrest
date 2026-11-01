export function getRepositoryDisplayName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** Adds only enough parent path to distinguish checkouts with the same basename. */
export function repositoryParentLabels(paths: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const path of paths) {
    const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
    const peers = paths.filter((peer) => peer !== path && getRepositoryDisplayName(peer).toLocaleLowerCase() === getRepositoryDisplayName(path).toLocaleLowerCase());
    if (!peers.length) continue;
    const parents = parts.slice(0, -1);
    for (let count = 1; count <= parents.length; count++) {
      const suffix = parents.slice(-count).join("/");
      if (peers.every((peer) => peer.replace(/[\\/]+$/, "").split(/[\\/]/).slice(0, -1).slice(-count).join("/").toLocaleLowerCase() !== suffix.toLocaleLowerCase()) || count === parents.length) {
        result.set(path, suffix);
        break;
      }
    }
  }
  return result;
}
