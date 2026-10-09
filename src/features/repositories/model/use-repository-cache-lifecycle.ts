import { useRef } from "react";

export function useRepositoryCacheLifecycle(isRepositoryOpen: (repoId: string) => boolean) {
  const generationByRepo = useRef(new Map<string, number>());
  const requestsByRepo = useRef(new Map<string, number>());

  function getGeneration(repoId: string): number {
    return generationByRepo.current.get(repoId) || 0;
  }

  function beginRequest(repoId: string): number {
    requestsByRepo.current.set(repoId, (requestsByRepo.current.get(repoId) || 0) + 1);
    return getGeneration(repoId);
  }

  function finishRequest(repoId: string) {
    const remaining = (requestsByRepo.current.get(repoId) || 1) - 1;
    if (remaining > 0) {
      requestsByRepo.current.set(repoId, remaining);
    } else {
      requestsByRepo.current.delete(repoId);
      if (!isRepositoryOpen(repoId)) generationByRepo.current.delete(repoId);
    }
  }

  function invalidate(repoId: string) {
    if (requestsByRepo.current.has(repoId)) {
      generationByRepo.current.set(repoId, getGeneration(repoId) + 1);
    } else {
      generationByRepo.current.delete(repoId);
    }
  }

  return { getGeneration, beginRequest, finishRequest, invalidate };
}
