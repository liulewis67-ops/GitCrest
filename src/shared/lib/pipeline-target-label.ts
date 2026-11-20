// Legacy task identity; keep this suffix intact when interpreting persisted tasks.
export const PIPELINE_WORKTREE_SUFFIX = " · pipeline worktree";
export function pipelineTargetLabel(target: string): string {
  return target.endsWith(PIPELINE_WORKTREE_SUFFIX) ? target.slice(0, -PIPELINE_WORKTREE_SUFFIX.length) : target;
}
