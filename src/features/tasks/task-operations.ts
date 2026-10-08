export function supportsWorkflowRecovery(operation: string): boolean {
  return ["merge", "cherryPick", "revert", "rebase", "pullMerge", "pullRebase"].includes(operation)
    || operation.startsWith("shelfApply:");
}
