import { useSyncExternalStore } from "react";
import type { GitCrestEventEnvelope } from "../../../api/bridge";
import type { PipelineRunResponse } from "../../../api/client";

/** A rule with confirmation "ask" fired after a push and waits for the user. */
export interface PipelineTriggerPrompt {
  runId: string;
  repoId: string;
  ruleId: string;
  ruleName: string;
  sourceBranch: string;
  targets: string[];
  protectedTarget: boolean;
}

/** The merge of a waiting step was aborted from the conflict window. */
export interface PipelineConflictPrompt {
  runId: string;
  repoId: string;
  position: number;
  targetBranch: string;
}

export interface PipelineState {
  /** Newest known snapshot of each run, by run id. */
  runs: Readonly<Record<string, PipelineRunResponse>>;
  triggers: readonly PipelineTriggerPrompt[];
  aborted: readonly PipelineConflictPrompt[];
}

export const EMPTY_PIPELINE_STATE: PipelineState = { runs: {}, triggers: [], aborted: [] };
const MAX_RUNS = 100;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRun(payload: Record<string, unknown>): payload is PipelineRunResponse & Record<string, unknown> {
  return Boolean(text(payload.runId) && text(payload.repoId) && text(payload.status) && Array.isArray(payload.steps));
}

/** Folds one core event into the pipeline state; events of other kinds return the same object. */
export function reducePipelineEvent(state: PipelineState, event: Pick<GitCrestEventEnvelope, "type" | "repoId" | "payload">): PipelineState {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "pipeline.run.updated" && isRun(payload)) {
    const run: PipelineRunResponse = payload;
    const runs = { ...state.runs, [run.runId]: run };
    const ids = Object.keys(runs);
    if (ids.length > MAX_RUNS) {
      const oldest = ids.sort((a, b) => runs[a].createdAtMs - runs[b].createdAtMs).slice(0, ids.length - MAX_RUNS);
      for (const id of oldest) delete runs[id];
    }
    return {
      runs,
      triggers: run.status === "pendingConfirmation" ? state.triggers : state.triggers.filter((prompt) => prompt.runId !== run.runId),
      aborted: run.status === "waitingForConflicts" ? state.aborted : state.aborted.filter((prompt) => prompt.runId !== run.runId),
    };
  }
  if (event.type === "pipeline.trigger.pending") {
    const runId = text(payload.runId);
    const repoId = event.repoId;
    const targets = Array.isArray(payload.targets) ? payload.targets.filter((target): target is string => typeof target === "string") : [];
    if (!runId || !repoId || targets.length === 0) return state;
    const prompt: PipelineTriggerPrompt = {
      runId,
      repoId,
      ruleId: text(payload.ruleId) ?? "",
      ruleName: text(payload.ruleName) ?? "",
      sourceBranch: text(payload.sourceBranch) ?? "",
      targets,
      protectedTarget: payload.protectedTarget === true,
    };
    return { ...state, triggers: [...state.triggers.filter((existing) => existing.runId !== runId), prompt] };
  }
  if (event.type === "pipeline.conflict.aborted") {
    const runId = text(payload.runId);
    const targetBranch = text(payload.targetBranch);
    const repoId = event.repoId;
    if (!runId || !targetBranch || !repoId || typeof payload.position !== "number") return state;
    const prompt: PipelineConflictPrompt = { runId, repoId, position: payload.position, targetBranch };
    return { ...state, aborted: [...state.aborted.filter((existing) => existing.runId !== runId), prompt] };
  }
  return state;
}

const listeners = new Set<() => void>();
let current: PipelineState = EMPTY_PIPELINE_STATE;

function set(next: PipelineState) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function applyPipelineEvent(event: Pick<GitCrestEventEnvelope, "type" | "repoId" | "payload">) {
  set(reducePipelineEvent(current, event));
}

/** Seeds the runs read from the core, for example after a reconnect. */
export function replacePipelineRuns(repoId: string, runs: readonly PipelineRunResponse[]) {
  const kept = Object.fromEntries(Object.entries(current.runs).filter(([, run]) => run.repoId !== repoId));
  const incoming = Object.fromEntries(runs.map((run) => [run.runId, run]));
  set({ ...current, runs: { ...kept, ...incoming } });
}

export function dismissPipelineTrigger(runId: string) {
  set({ ...current, triggers: current.triggers.filter((prompt) => prompt.runId !== runId) });
}

export function dismissPipelineConflictPrompt(runId: string) {
  set({ ...current, aborted: current.aborted.filter((prompt) => prompt.runId !== runId) });
}

export function resetPipelineState() {
  set(EMPTY_PIPELINE_STATE);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePipelineState(): PipelineState {
  return useSyncExternalStore(subscribe, () => current, () => EMPTY_PIPELINE_STATE);
}
