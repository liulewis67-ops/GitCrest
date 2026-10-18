import { t } from "../../../shared/i18n";
import { useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type RepositoryResponse,
} from "../../../api/client";

interface RepositoryOpeningOptions {
  getApi: () => GitCrestApiClient | undefined;
  chooseRepository: () => Promise<string | undefined>;
  onRepositoryOpened: (repository: RepositoryResponse, sortByRecentAccess: boolean) => void;
  refreshRepositories: (api: GitCrestApiClient) => Promise<void>;
  setError: (message: string) => void;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof GitCrestApiError) return error.body.error.message;
  return error instanceof Error ? error.message : fallback;
}

export function useRepositoryOpening({ getApi, chooseRepository, onRepositoryOpened, refreshRepositories, setError }: RepositoryOpeningOptions) {
  const [opening, setOpening] = useState(false);

  async function openAtPath(path: string) {
    setError("");
    const api = getApi();
    if (!api) {
      setError(t("err.engineStarting"));
      return;
    }
    setOpening(true);
    try {
      onRepositoryOpened(await api.openRepository(path), false);
    } catch (error) {
      setError(errorMessage(error, t("err.openRepo")));
    } finally {
      setOpening(false);
    }
  }

  async function initializeAtPath(path: string) {
    setError("");
    const api = getApi();
    if (!api) {
      setError(t("err.engineStarting"));
      return;
    }
    setOpening(true);
    try {
      onRepositoryOpened(await api.initializeRepository(path), false);
    } catch (error) {
      setError(errorMessage(error, t("err.initFolder")));
    } finally {
      setOpening(false);
    }
  }

  async function openRecent(repository: RepositoryResponse) {
    const api = getApi();
    if (!api || repository.availability !== "available") return;
    setError("");
    setOpening(true);
    try {
      onRepositoryOpened(await api.getRepository(repository.repoId), true);
    } catch (error) {
      setError(errorMessage(error, t("err.reopenRepo")));
      void refreshRepositories(api).catch(() => undefined);
    } finally {
      setOpening(false);
    }
  }

  async function chooseAndOpenLocal() {
    setError("");
    try {
      const path = await chooseRepository();
      if (path) await openAtPath(path);
    } catch (error) {
      setError(errorMessage(error, t("err.openRepo")));
    }
  }

  async function chooseAndInitializeLocal() {
    setError("");
    try {
      const path = await chooseRepository();
      if (path) await initializeAtPath(path);
    } catch (error) {
      setError(errorMessage(error, t("err.initFolder")));
    }
  }

  return { opening, openAtPath, openRecent, chooseAndOpenLocal, chooseAndInitializeLocal };
}
