export interface DiffWindowRequest {
  repoId: string;
  path: string;
  /** `range` is a file of a comparison: from `fromOid` to `toOid`, or to the working tree when `toOid` is absent. */
  scope: "workingTree" | "index" | "commit" | "range";
  commitOid?: string;
  fromOid?: string;
  toOid?: string;
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** Checks what the main window asked for before any of it reaches a window's address or another renderer. */
export function parseDiffWindowRequest(value: unknown): DiffWindowRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid Diff window request.");
  const request = value as Partial<DiffWindowRequest>;
  if (typeof request.repoId !== "string" || !/^repo_[a-f0-9]{64}$/.test(request.repoId)) {
    throw new Error("Invalid repository ID for Diff window.");
  }
  if (typeof request.path !== "string" || request.path.trim().length === 0 || request.path.length > 4096) {
    throw new Error("Invalid file path for Diff window.");
  }
  if (!["workingTree", "index", "commit", "range"].includes(request.scope || "")) {
    throw new Error("Invalid Diff scope.");
  }
  if (request.scope === "commit" && (typeof request.commitOid !== "string" || !OBJECT_ID.test(request.commitOid))) {
    throw new Error("A full commit ID is required for a historical Diff window.");
  }
  if (request.scope !== "commit" && request.commitOid !== undefined) {
    throw new Error("A commit ID is only valid for a historical Diff window.");
  }
  if (request.scope === "range") {
    if (typeof request.fromOid !== "string" || !OBJECT_ID.test(request.fromOid)) {
      throw new Error("A full starting commit ID is required for a comparison Diff window.");
    }
    if (request.toOid !== undefined && (typeof request.toOid !== "string" || !OBJECT_ID.test(request.toOid))) {
      throw new Error("The end of a comparison must be a full commit ID or left out for the working tree.");
    }
  } else if (request.fromOid !== undefined || request.toOid !== undefined) {
    throw new Error("Commit IDs for a comparison are only valid for a comparison Diff window.");
  }
  return request as DiffWindowRequest;
}
