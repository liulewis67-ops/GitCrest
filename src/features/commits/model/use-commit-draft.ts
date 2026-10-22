import { useState } from "react";
import type { CommitRequest } from "../../../api/client";
import { composeCommitMessage, splitCommitMessage } from "./commit-message";

type CommitSelections = NonNullable<CommitRequest["selections"]>;

interface CommitDraft {
  summary: string;
  description: string;
  template: string;
  amend: boolean;
  signOff: boolean;
  sign: boolean;
  selections: CommitSelections;
}

const EMPTY_DRAFT: CommitDraft = {
  summary: "",
  description: "",
  template: "plain",
  amend: false,
  signOff: false,
  sign: false,
  selections: [],
};

/**
 * The commit composer's draft, kept per repository: switching tabs shows each repository's own
 * message, options and diff selections, and switching back finds them as they were left.
 */
export function useCommitDraft(repoId?: string) {
  const [drafts, setDrafts] = useState<Record<string, CommitDraft>>({});
  const draft = (repoId && drafts[repoId]) || EMPTY_DRAFT;

  function updateDraft(targetRepoId: string | undefined, change: (current: CommitDraft) => Partial<CommitDraft>) {
    if (!targetRepoId) return;
    setDrafts((current) => {
      const previous = current[targetRepoId] || EMPTY_DRAFT;
      return { ...current, [targetRepoId]: { ...previous, ...change(previous) } };
    });
  }

  function addDiffSelection(path: string, revision: string, selectedHunks: Array<{ hunkIndex: number; rowIndex?: number }>) {
    updateDraft(repoId, (current) => ({
      selections: [
        ...current.selections.filter((item) => item.path !== path),
        { path, revision, selections: selectedHunks },
      ],
    }));
  }

  const message = composeCommitMessage(draft.summary, draft.description);

  function setMessage(nextMessage: string) {
    const parts = splitCommitMessage(nextMessage);
    updateDraft(repoId, () => ({ summary: parts.summary, description: parts.description }));
  }

  // Templates only prefix the summary line; the optional description is kept.
  function chooseTemplate(nextTemplate: string) {
    const summary = nextTemplate === "conventional" ? "feat: " : nextTemplate === "fix" ? "fix: " : "";
    updateDraft(repoId, () => ({ template: nextTemplate, summary }));
  }

  /**
   * Clears what a finished commit used from its repository's draft. A message or selection the user
   * changed while the commit ran is newer than the commit, so it stays.
   */
  function clearCommitted(targetRepoId: string, committedMessage: string, committedSelections: string) {
    updateDraft(targetRepoId, (current) => ({
      ...(composeCommitMessage(current.summary, current.description) === committedMessage ? { summary: "", description: "" } : {}),
      ...(JSON.stringify(current.selections) === committedSelections ? { selections: [] } : {}),
    }));
  }

  return {
    message,
    setMessage,
    summary: draft.summary,
    setSummary: (summary: string) => updateDraft(repoId, () => ({ summary })),
    description: draft.description,
    setDescription: (description: string) => updateDraft(repoId, () => ({ description })),
    template: draft.template,
    setTemplate: (template: string) => updateDraft(repoId, () => ({ template })),
    amend: draft.amend,
    setAmend: (amend: boolean) => updateDraft(repoId, () => ({ amend })),
    signOff: draft.signOff,
    setSignOff: (signOff: boolean) => updateDraft(repoId, () => ({ signOff })),
    sign: draft.sign,
    setSign: (sign: boolean) => updateDraft(repoId, () => ({ sign })),
    selections: draft.selections,
    setSelections: (selections: CommitSelections) => updateDraft(repoId, () => ({ selections })),
    // Selections live in their repository's draft, so they always belong to the shown repository.
    selectionRepoId: repoId,
    addDiffSelection,
    chooseTemplate,
    clearCommitted,
  };
}
