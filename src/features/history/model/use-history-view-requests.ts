import { useState } from "react";

export interface CommitTagRequest {
  repoId: string;
  oid: string;
  sequence: number;
}

export interface HistorySearchFocusRequest {
  repoId: string;
  sequence: number;
}

export function useHistoryViewRequests() {
  const [tagEditorRequest, setTagEditorRequest] = useState<CommitTagRequest>();
  const [searchFocusRequest, setSearchFocusRequest] = useState<HistorySearchFocusRequest>();

  function openTagEditor(repoId: string, oid: string) {
    setTagEditorRequest((current) => ({ repoId, oid, sequence: (current?.sequence || 0) + 1 }));
  }

  function markTagEditorHandled(sequence: number) {
    setTagEditorRequest((current) => current?.sequence === sequence ? undefined : current);
  }

  function focusSearch(repoId: string) {
    setSearchFocusRequest((current) => ({ repoId, sequence: (current?.sequence || 0) + 1 }));
  }

  function markSearchFocusHandled(sequence: number) {
    setSearchFocusRequest((current) => current?.sequence === sequence ? undefined : current);
  }

  return {
    tagEditorRequest,
    openTagEditor,
    markTagEditorHandled,
    searchFocusRequest,
    focusSearch,
    markSearchFocusHandled,
  };
}
