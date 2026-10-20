import { useEffect, useState } from "react";
import type { CommitRequest } from "../../../api/client";
import { composeCommitMessage, splitCommitMessage } from "./commit-message";

export function useCommitDraft(repoId?: string) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState("plain");
  const [amend, setAmend] = useState(false);
  const [signOff, setSignOff] = useState(false);
  const [sign, setSign] = useState(false);
  const [selections, setSelections] = useState<NonNullable<CommitRequest["selections"]>>([]);
  const [selectionRepoId, setSelectionRepoId] = useState<string>();

  function addDiffSelection(path: string, revision: string, selectedHunks: Array<{ hunkIndex: number; rowIndex?: number }>) {
    if (!repoId) return;
    setSelectionRepoId(repoId);
    setSelections((current) => [
      ...current.filter((item) => item.path !== path),
      { path, revision, selections: selectedHunks },
    ]);
  }

  const message = composeCommitMessage(summary, description);

  function setMessage(nextMessage: string) {
    const parts = splitCommitMessage(nextMessage);
    setSummary(parts.summary);
    setDescription(parts.description);
  }

  // Templates only prefix the summary line; the optional description is kept.
  function chooseTemplate(nextTemplate: string) {
    setTemplate(nextTemplate);
    if (nextTemplate === "conventional") setSummary("feat: ");
    else if (nextTemplate === "fix") setSummary("fix: ");
    else setSummary("");
  }

  useEffect(() => {
    setSelections([]);
    setSelectionRepoId(repoId);
    setSummary("");
    setDescription("");
    setTemplate("plain");
    setAmend(false);
    setSignOff(false);
    setSign(false);
  }, [repoId]);

  return {
    message,
    setMessage,
    summary,
    setSummary,
    description,
    setDescription,
    template,
    setTemplate,
    amend,
    setAmend,
    signOff,
    setSignOff,
    sign,
    setSign,
    selections,
    setSelections,
    selectionRepoId,
    addDiffSelection,
    chooseTemplate,
  };
}
