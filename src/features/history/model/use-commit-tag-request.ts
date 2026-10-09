import { useState } from "react";

export interface CommitTagRequest {
  repoId: string;
  oid: string;
  sequence: number;
}

export function useCommitTagRequest() {
  const [request, setRequest] = useState<CommitTagRequest>();

  function open(repoId: string, oid: string) {
    setRequest((current) => ({ repoId, oid, sequence: (current?.sequence || 0) + 1 }));
  }

  function markHandled(sequence: number) {
    setRequest((current) => current?.sequence === sequence ? undefined : current);
  }

  return { request, open, markHandled };
}
