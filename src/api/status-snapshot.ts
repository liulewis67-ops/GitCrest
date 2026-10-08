import type { StatusSnapshotResponse } from "./client";

export function mergeStatusScope(
  current: StatusSnapshotResponse,
  partial: StatusSnapshotResponse,
  paths: string[],
): StatusSnapshotResponse {
  const normalized = paths.map((path) => path.replace(/\\/g, "/").replace(/\/+$/, ""));
  const isWithinScope = (path: string) => normalized.some((scope) =>
    path === scope || path.startsWith(`${scope}/`),
  );
  const unchanged = current.files.filter((file) =>
    !isWithinScope(file.path)
      && !(file.originalPath && isWithinScope(file.originalPath)),
  );
  return {
    repoId: partial.repoId,
    refreshedAtMs: partial.refreshedAtMs,
    files: [...unchanged, ...partial.files].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
