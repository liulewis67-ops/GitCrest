import { type DisplayError } from "../../shared/i18n/api-errors";
import { useI18n } from "../../shared/i18n";
import { useRef, useState } from "react";
import { type RepositoryResponse } from "../../api/client";
import { type AppPage } from "../layouts/AppTitlebar";
import { type CommitPanelTab } from "../../pages/workspace/CommitPanel";
import { useShortcutPreferences, useUpdateStatus, type SettingsSectionId } from "../../features/settings";
import { notify } from "../../shared/notices/notice-store";
import { useCommitDraft } from "../../features/commits";
import { useWorkspaceSessionState, type WorkspaceMode } from "../../features/repositories";
import { type IgnoreMode } from "../../features/changes";
import { useHistoryViewRequests } from "../../features/history";
import { type LocalBranchAction } from "../../features/branches";


export function useAppShell() {

  const { t } = useI18n();

  const isMacPlatform = navigator.platform.toLowerCase().includes("mac");

  const commandKey = isMacPlatform ? "⌘" : "Ctrl";

  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);

  const [selectedRepository, setSelectedRepository] = useState<RepositoryResponse>();

  const [pushTargetDialogOpen, setPushTargetDialogOpen] = useState(false);

  const historyRequests = useHistoryViewRequests();

  const [shelfComposerRequest, setShelfComposerRequest] = useState<{ id: number; repoId?: string; preselect?: { paths: string[]; scope: "workingTree" | "index" } }>({ id: 0 });

  const [tasksOpen, setTasksOpen] = useState(false);

  const [localBranchAction, setLocalBranchAction] = useState<LocalBranchAction>();

  const [createBranchAt, setCreateBranchAt] = useState<string>();

  /** The branch chosen in the Branches view, whose history its commit graph shows. */
  const [historyBranch, setHistoryBranch] = useState<{ repoId: string; fullName: string }>();

  const [worktreeForBranch, setWorktreeForBranch] = useState<{ name: string; fromRemote: boolean }>();

  const [reflogOpen, setReflogOpen] = useState(false);

  const [submodulesOpen, setSubmodulesOpen] = useState(false);

  const [compareRequest, setCompareRequest] = useState<{ base?: string; head?: string; workingTree?: boolean }>();

  const [pipelineRunSource, setPipelineRunSource] = useState<{ branch: string; oid: string }>();

  const [ignoreRequest, setIgnoreRequest] = useState<{ repoId: string; path: string; mode: IgnoreMode }>();

  const [worktreeFrom, setWorktreeFrom] = useState<{ oid: string; label: string }>();

  const [removeWorktreePath, setRemoveWorktreePath] = useState<string>();

  // Settings covers the content area while open; the page underneath stays mounted.
  const [settingsView, setSettingsView] = useState<{ section?: SettingsSectionId; credentialHosts?: string[]; reopenClone?: boolean }>();

  const { updateStatus, checkForUpdates, installUpdate } = useUpdateStatus();

  const { shortcuts, setShortcuts } = useShortcutPreferences();

  const {
    message: commitMessage,
    setMessage: setCommitMessage,
    summary: commitSummary,
    setSummary: setCommitSummary,
    description: commitDescription,
    setDescription: setCommitDescription,
    template: commitTemplate,
    amend: amendCommit,
    setAmend: setAmendCommit,
    signOff: signOffCommit,
    setSignOff: setSignOffCommit,
    sign: signCommit,
    setSign: setSignCommit,
    selections: commitSelections,
    setSelections: setCommitSelections,
    selectionRepoId: commitSelectionRepoId,
    addDiffSelection: addCommitDiffSelection,
    chooseTemplate: chooseCommitTemplate,
    clearCommitted: clearCommittedDraft,
  } = useCommitDraft(selectedRepository?.repoId);

  const [commitAssistantOpen, setCommitAssistantOpen] = useState(false);

  const [commitActionMenuOpen, setCommitActionMenuOpen] = useState(false);

  const [openError, setOpenError] = useState<DisplayError>("");

  const [page, setPage] = useState<AppPage>("welcome");

  const { session: workspaceSession, setSession: setWorkspaceSession, sessionRef: workspaceSessionRef } = useWorkspaceSessionState();

  // A floating inspector is opened per view and per visit; it never reopens by itself.
  const [overlayInspectorFor, setOverlayInspectorFor] = useState<WorkspaceMode>();

  const [focusMode, setFocusMode] = useState(false);

  const [commitPanelTab, setCommitPanelTab] = useState<CommitPanelTab>("commit");

  // Failures go to the shared notice queue; the helpers below pick the kind for the other cases.
  const setNotice = (message: DisplayError) => { notify.error(message); };

  const [paletteOpen, setPaletteOpen] = useState(false);

  const [paletteQuery, setPaletteQuery] = useState("");

  function isRepositoryTabOpen(repoId: string): boolean {
    return workspaceSessionRef.current.openRepoIds.includes(repoId);
  }

  const selectedRepositoryRef = useRef(selectedRepository);

  selectedRepositoryRef.current = selectedRepository;
  return { t, isMacPlatform, commandKey, repositories, setRepositories, selectedRepository, setSelectedRepository, pushTargetDialogOpen, setPushTargetDialogOpen, historyRequests, shelfComposerRequest, setShelfComposerRequest, tasksOpen, setTasksOpen, localBranchAction, setLocalBranchAction, createBranchAt, setCreateBranchAt, historyBranch, setHistoryBranch, worktreeForBranch, setWorktreeForBranch, reflogOpen, setReflogOpen, submodulesOpen, setSubmodulesOpen, compareRequest, setCompareRequest, pipelineRunSource, setPipelineRunSource, ignoreRequest, setIgnoreRequest, worktreeFrom, setWorktreeFrom, removeWorktreePath, setRemoveWorktreePath, settingsView, setSettingsView, updateStatus, checkForUpdates, installUpdate, shortcuts, setShortcuts, commitMessage, setCommitMessage, commitSummary, setCommitSummary, commitDescription, setCommitDescription, commitTemplate, amendCommit, setAmendCommit, signOffCommit, setSignOffCommit, signCommit, setSignCommit, commitSelections, setCommitSelections, commitSelectionRepoId, addCommitDiffSelection, chooseCommitTemplate, clearCommittedDraft, commitAssistantOpen, setCommitAssistantOpen, commitActionMenuOpen, setCommitActionMenuOpen, openError, setOpenError, page, setPage, workspaceSession, setWorkspaceSession, workspaceSessionRef, overlayInspectorFor, setOverlayInspectorFor, focusMode, setFocusMode, commitPanelTab, setCommitPanelTab, setNotice, paletteOpen, setPaletteOpen, paletteQuery, setPaletteQuery, isRepositoryTabOpen, selectedRepositoryRef };
}

export type Shell = ReturnType<typeof useAppShell>;
