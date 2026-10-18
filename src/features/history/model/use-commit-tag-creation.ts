import { t } from "../../../shared/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCrestApiClient } from "../../../api/client";

export function useCommitTagCreation(api: GitCrestApiClient, repoId: string, oid?: string) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    setStatus("");
    setError("");
    setEditorOpen(false);
    setName("");
    setMessage("");
  }, [oid, repoId]);

  const openEditor = useCallback(() => {
    setError("");
    setEditorOpen(true);
  }, []);

  const toggleEditor = useCallback(() => {
    setError("");
    setEditorOpen((current) => !current);
  }, []);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setName("");
    setMessage("");
  }, []);

  const createTag = useCallback(async () => {
    if (!oid || busy) return false;
    const requestGeneration = generation.current;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const tag = await api.createRepositoryCommitTag(repoId, oid, name.trim(), message);
      if (generation.current !== requestGeneration) return false;
      setStatus(t("tag.created", { name: tag.name, oid: oid.slice(0, 12) }));
      closeEditor();
      return true;
    } catch (reason) {
      if (generation.current === requestGeneration) {
        setError(reason instanceof Error ? reason.message : t("err.tagFailed"));
      }
      return false;
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  }, [api, busy, closeEditor, message, name, oid, repoId]);

  return { busy, status, error, editorOpen, name, message, setName, setMessage, openEditor, toggleEditor, createTag };
}
