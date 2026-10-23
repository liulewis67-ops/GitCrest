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

export interface HistoryPathFilterRequest {
  repoId: string;
  path: string;
  sequence: number;
}

export function useHistoryViewRequests() {
  const [tagEditorRequest, setTagEditorRequest] = useState<CommitTagRequest>();
  const [searchFocusRequest, setSearchFocusRequest] = useState<HistorySearchFocusRequest>();
  const [pathFilterRequest, setPathFilterRequest] = useState<HistoryPathFilterRequest>();
  const [refreshKey, setRefreshKey] = useState(0);

  function refresh() {
    setRefreshKey((current) => current + 1);
  }

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

  function showFileHistory(repoId: string, path: string) {
    setPathFilterRequest((current) => ({ repoId, path, sequence: (current?.sequence || 0) + 1 }));
  }

  function markPathFilterHandled(sequence: number) {
    setPathFilterRequest((current) => current?.sequence === sequence ? undefined : current);
  }

  return {
    tagEditorRequest,
    refreshKey,
    refresh,
    openTagEditor,
    markTagEditorHandled,
    searchFocusRequest,
    focusSearch,
    markSearchFocusHandled,
    pathFilterRequest,
    showFileHistory,
    markPathFilterHandled,
  };
}
