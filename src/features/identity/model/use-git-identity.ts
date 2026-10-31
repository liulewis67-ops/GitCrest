import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useCallback, useEffect, useState } from "react";
import { type GitCrestApiClient, type GitIdentityResponse } from "../../../api/client";

export type IdentityScope = "global" | "local";

function errorMessage(error: unknown, fallback: string) {
  return describeApiError(error, fallback);
}

/**
 * The author identity Git resolves. With a repository it is the effective identity there (a
 * repository-level value overrides the global one); without one it is the global identity.
 */
export function useGitIdentity(api: GitCrestApiClient | undefined, repoId?: string, enabled = true) {
  const [identity, setIdentity] = useState<{ key: string; value: GitIdentityResponse }>();
  const [error, setError] = useState<DisplayError>("");
  const key = repoId ?? "";

  const refresh = useCallback(async () => {
    if (!api || !enabled) return;
    try {
      const value = repoId ? await api.getRepositoryIdentity(repoId) : await api.getGlobalIdentity();
      setIdentity({ key, value });
      setError("");
    } catch (reason) {
      setError(errorMessage(reason, "Could not read the Git identity."));
    }
  }, [api, repoId, key, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(name: string, email: string, scope: IdentityScope) {
    if (!api) return;
    const value = scope === "local" && repoId
      ? await api.setRepositoryIdentity(repoId, name, email)
      : await api.setGlobalIdentity(name, email);
    // A global save can be shadowed by a repository value, so re-read the effective identity.
    if (repoId && scope === "global") await refresh();
    else setIdentity({ key, value });
  }

  async function clearLocal() {
    if (!api || !repoId) return;
    setIdentity({ key, value: await api.clearRepositoryIdentity(repoId) });
  }

  // A stale answer for another repository is not shown for this one.
  const current = identity?.key === key ? identity.value : undefined;
  return { identity: current, error, refresh, save, clearLocal };
}
