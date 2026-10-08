import { useEffect, useState } from "react";
import type { CommitRequest } from "../../../api/client";

export function useCommitDraft(repoId?: string) {
  const [message, setMessage] = useState("");
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

  function chooseTemplate(nextTemplate: string) {
    setTemplate(nextTemplate);
    if (nextTemplate === "conventional") setMessage("feat: ");
    else if (nextTemplate === "fix") setMessage("fix: ");
    else setMessage("");
  }

  useEffect(() => {
    setSelections([]);
    setSelectionRepoId(repoId);
    setMessage("");
    setTemplate("plain");
    setAmend(false);
    setSignOff(false);
    setSign(false);
  }, [repoId]);

  return {
    message,
    setMessage,
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
