import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient } from "../../../api/client";

export function useCommitTagCreation(api: GitCrestApiClient, repoId: string, oid?: string) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    setStatus("");
    setError("");
  }, [oid, repoId]);

  async function createTag(name: string, message: string) {
    if (!oid || busy) return false;
    const requestGeneration = generation.current;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const tag = await api.createRepositoryCommitTag(repoId, oid, name, message);
      if (generation.current !== requestGeneration) return false;
      setStatus(`Annotated tag ${tag.name} created at ${oid.slice(0, 12)}.`);
      return true;
    } catch (reason) {
      if (generation.current === requestGeneration) {
        setError(reason instanceof Error ? reason.message : "Could not create this tag.");
      }
      return false;
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  }

  return { busy, status, error, setError, createTag };
}
