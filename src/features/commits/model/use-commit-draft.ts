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
    setSelectionRepoId,
  };
}
