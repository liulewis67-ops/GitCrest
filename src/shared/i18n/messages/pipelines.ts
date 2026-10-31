export const pipelinesMessages = {
  "pl.conflictAborted.eyebrow": ["PIPELINE", "流水线"],
  "pl.conflictAborted.title": ["The merge into {target} was aborted", "已中止合并到 {target}"],
  "pl.conflictAborted.body": ["The pipeline is waiting. Skip {target} and carry on with the next target, or stop the pipeline.", "流水线正在等待。你可以跳过 {target} 并继续下一个目标，或停止流水线。"],
  "pl.conflictAborted.skip": ["Skip this target", "跳过此目标"],
  "pl.conflictAborted.stop": ["Stop the pipeline", "停止流水线"],
  "pl.conflictAborted.later": ["Decide later", "稍后决定"],
  "pl.actionFailed": ["The pipeline could not apply that choice.", "流水线无法应用该选择。"],
} as const;
