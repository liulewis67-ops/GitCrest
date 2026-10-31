import { Suspense } from "react";
import { requireGitCrestBridge } from "../../api/bridge";
import { NoticeRegion } from "../../shared/ui/NoticeRegion";
import { IgnoreRuleDialog } from "../../features/changes";
import { PushDialog, PushTargetDialog, PullDialog, TaskCenter, DiscardChangesDialog, CreateBranchDialog, NewWorktreeDialog, SubmodulesDialog, CompareDialog, ReflogDialog, RemoveWorktreeDialog, LocalBranchDialog, WorkflowDialog, RebaseDialog, ResetDialog, RemoteBranchDeleteDialog, CloneDialog } from "./lazy-views";
import type { AppContext } from "./app-context";

export function AppDialogs({ ctx }: { ctx: AppContext }) {
  const { activeBranches, activeRemotes, apiRef, canCommit, cancelTask, clearDiscardSelection, cloneSubmission, commitChanges, compareRequest, configureTaskCredentials, connected, copyTaskLogs, createBranchAt, discardSelectedChanges, discardSelection, fetchFromPushDialog, folderDragging, hasActiveDiscardRepositoryTask, hasActiveRepositoryTask, hasActiveStagingTask, ignoreRequest, localBranchAction, openAccountSettings, openConflictWindow, prependTask, pullBusy, pullDisabledReason, pullError, pullLoading, pullOpen, pullPreflight, pushBusy, pushDisabledReason, pushError, pushForceOnly, pushLoading, pushOpen, pushPreflight, pushTargetDialogOpen, recoverWorkflow, reflogOpen, refreshPullPreflight, refreshPushPreflight, refreshRepositoryStatus, refreshTasks, remoteBranchDelete, remoteDisabledReason, removeWorktreePath, repositoryOpening, reviewTaskPush, selectedRepository, setCompareRequest, setCreateBranchAt, setIgnoreRequest, setLocalBranchAction, setPullOpen, setPushOpen, setPushTargetDialogOpen, setReflogOpen, setRemoveWorktreePath, setSettingsView, setSubmodulesOpen, setTasksError, setTasksOpen, setWorktreeForBranch, setWorktreeFrom, stagingBusy, submitPull, submitPush, submodulesOpen, t, taskActionId, tasks, tasksError, tasksOpen, workflowDialog, worktreeForBranch, worktreeFrom } = ctx;
  return (
    <>
          <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("load.dialog")}</div>}>
          {pushOpen && <PushDialog snapshot={pushPreflight} loading={pushLoading} busy={pushBusy} error={pushError} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} disabledReason={pushDisabledReason} forceWithLeaseOnly={pushForceOnly} onRefresh={() => void refreshPushPreflight()} onFetch={fetchFromPushDialog} onPush={(forceWithLease, tags) => void submitPush(forceWithLease, tags)} onClose={() => setPushOpen(false)} />}
          {pushTargetDialogOpen && <PushTargetDialog remotes={activeRemotes} branches={activeBranches} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask || !canCommit} disabledReason={hasActiveRepositoryTask ? t("app.waitTask") : !canCommit ? t("app.stageFirst") : remoteDisabledReason} onChoose={(target) => { setPushTargetDialogOpen(false); void commitChanges("commitAndPushTo", target); }} onClose={() => setPushTargetDialogOpen(false)} />}
          {pullOpen && <PullDialog snapshot={pullPreflight} loading={pullLoading} busy={pullBusy} error={pullError} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} disabledReason={pullDisabledReason} onRefresh={() => void refreshPullPreflight()} onPull={(strategy) => void submitPull(strategy)} onClose={() => setPullOpen(false)} />}
          {tasksOpen && <TaskCenter api={apiRef.current} tasks={tasks} error={tasksError} actionId={taskActionId} onClose={() => setTasksOpen(false)} onRefresh={() => void refreshTasks()} onCancel={(taskId) => void cancelTask(taskId)} onCopy={(task) => void copyTaskLogs(task)} onRetryClone={(task) => cloneSubmission.retryFromTask(task)} onOpenSigningSettings={() => { setTasksOpen(false); setSettingsView({ section: "general" }); }} onConfigureCredentials={configureTaskCredentials} onReviewPush={reviewTaskPush} onRecoverWorkflow={(task, _preview, action) => void recoverWorkflow(task, action)} onOpenConflictWindow={(task) => void openConflictWindow(task)} />}
          {discardSelection && <DiscardChangesDialog repositoryPath={discardSelection.repositoryPath} path={discardSelection.path} selectionCount={discardSelection.selections.length} disabled={stagingBusy || hasActiveStagingTask || hasActiveDiscardRepositoryTask} error={tasksError || undefined} onCancel={clearDiscardSelection} onConfirm={() => void discardSelectedChanges()} />}
          {createBranchAt && selectedRepository && apiRef.current && <Suspense fallback={null}><CreateBranchDialog api={apiRef.current} repoId={selectedRepository.repoId} repositoryPath={selectedRepository.path} onChooseFolder={() => requireGitCrestBridge().chooseCloneParent()} startOid={createBranchAt} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setCreateBranchAt(undefined)} onStarted={(task) => { prependTask(task); setCreateBranchAt(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
          {worktreeForBranch && selectedRepository && apiRef.current && <Suspense fallback={null}><NewWorktreeDialog api={apiRef.current} repoId={selectedRepository.repoId} repositoryPath={selectedRepository.path} branch={worktreeForBranch.name} fromRemote={worktreeForBranch.fromRemote} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onChooseFolder={() => requireGitCrestBridge().chooseCloneParent()} onClose={() => setWorktreeForBranch(undefined)} onStarted={(task) => { prependTask(task); setWorktreeForBranch(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
          {submodulesOpen && selectedRepository && apiRef.current && <Suspense fallback={null}><SubmodulesDialog
            api={apiRef.current}
            repoId={selectedRepository.repoId}
            disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask}
            onClose={() => setSubmodulesOpen(false)}
            onOpen={(path) => { setSubmodulesOpen(false); void repositoryOpening.openAtPath(`${selectedRepository.path.replace(/[\\/]+$/, "")}/${path}`); }}
            onStarted={(task) => { prependTask(task); setSubmodulesOpen(false); setTasksError(""); setTasksOpen(true); }}
          /></Suspense>}
          {compareRequest && selectedRepository && apiRef.current && <Suspense fallback={null}><CompareDialog
            api={apiRef.current}
            repoId={selectedRepository.repoId}
            initial={compareRequest}
            currentBranch={activeBranches?.branches.find((branch) => branch.isCurrent)?.name}
            refNames={(activeBranches?.branches ?? []).map((branch) => branch.name)}
            onClose={() => setCompareRequest(undefined)}
          /></Suspense>}
          {reflogOpen && selectedRepository && apiRef.current && <Suspense fallback={null}><ReflogDialog
            api={apiRef.current}
            repoId={selectedRepository.repoId}
            branchNames={(activeBranches?.branches ?? []).filter((branch) => branch.kind === "local").map((branch) => branch.name)}
            disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask}
            onClose={() => setReflogOpen(false)}
            onCreateBranch={(oid) => { setReflogOpen(false); setCreateBranchAt(oid); }}
            onResetTo={(oid) => { setReflogOpen(false); workflowDialog.openReset(oid); }}
          /></Suspense>}
          {ignoreRequest && selectedRepository?.repoId === ignoreRequest.repoId && apiRef.current && <IgnoreRuleDialog
            api={apiRef.current}
            repoId={ignoreRequest.repoId}
            path={ignoreRequest.path}
            mode={ignoreRequest.mode}
            onClose={() => setIgnoreRequest(undefined)}
            onAdded={() => { const { repoId } = ignoreRequest; setIgnoreRequest(undefined); void refreshRepositoryStatus(repoId, true); }}
          />}
          {worktreeFrom && selectedRepository && apiRef.current && <Suspense fallback={null}><CreateBranchDialog api={apiRef.current} repoId={selectedRepository.repoId} repositoryPath={selectedRepository.path} onChooseFolder={() => requireGitCrestBridge().chooseCloneParent()} startOid={worktreeFrom.oid} worktreeFrom={worktreeFrom.label} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setWorktreeFrom(undefined)} onStarted={(task) => { prependTask(task); setWorktreeFrom(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
          {removeWorktreePath && selectedRepository && apiRef.current && <Suspense fallback={null}><RemoveWorktreeDialog api={apiRef.current} repoId={selectedRepository.repoId} path={removeWorktreePath} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setRemoveWorktreePath(undefined)} onStarted={(task) => { prependTask(task); setRemoveWorktreePath(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
          {localBranchAction && selectedRepository && apiRef.current && <Suspense fallback={null}><LocalBranchDialog api={apiRef.current} repoId={selectedRepository.repoId} action={localBranchAction} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setLocalBranchAction(undefined)} onStarted={(task) => { prependTask(task); setLocalBranchAction(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
          {workflowDialog.context && apiRef.current && <WorkflowDialog api={apiRef.current} repoId={workflowDialog.context.repoId} targetOid={workflowDialog.context.targetOid} action={workflowDialog.context.action} targetLabel={workflowDialog.context.targetLabel} onClose={workflowDialog.close} onStarted={workflowDialog.startTask} />}
          {workflowDialog.rebaseOpen && selectedRepository && apiRef.current && <RebaseDialog api={apiRef.current} repoId={selectedRepository.repoId} branches={activeBranches} initialOntoOid={workflowDialog.rebaseOnto} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={workflowDialog.closeRebase} onStarted={(task) => { workflowDialog.closeRebase(); workflowDialog.startTask(task); }} />}
          {workflowDialog.resetOpen && selectedRepository && apiRef.current && <ResetDialog api={apiRef.current} repoId={selectedRepository.repoId} branches={activeBranches} initialTargetOid={workflowDialog.resetTargetOid} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={workflowDialog.closeReset} onStarted={(task) => { workflowDialog.closeReset(); workflowDialog.startTask(task); }} />}
          {remoteBranchDelete.target && selectedRepository && apiRef.current && <RemoteBranchDeleteDialog api={apiRef.current} repoId={selectedRepository.repoId} branchRef={remoteBranchDelete.target} remotes={activeRemotes} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={remoteBranchDelete.close} onStarted={remoteBranchDelete.startTask} />}
          {folderDragging && <div className="folderDropOverlay" aria-hidden="true"><div>{t("drop.hint")}</div></div>}
          <NoticeRegion />
          {cloneSubmission.dialogOpen && <CloneDialog initialRemoteUrl={cloneSubmission.draft.remoteUrl} initialDirectoryName={cloneSubmission.draft.directoryName} parentPath={cloneSubmission.draft.parentPath} error={cloneSubmission.error} busy={cloneSubmission.busy} onManageAccounts={(draft, hosts) => { cloneSubmission.stashDraft(draft); openAccountSettings(hosts, true); }} onChooseParent={() => requireGitCrestBridge().chooseCloneParent()} onClose={cloneSubmission.closeDialog} onSubmit={(remoteUrl, parentPath, directoryName) => void cloneSubmission.submit(remoteUrl, parentPath, directoryName)} />}
          </Suspense>
    </>
  );
}
