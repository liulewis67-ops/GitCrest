import { useState } from "react";
import type { CommitHistoryFilters } from "../../../api/client";

export function useHistoryFilters() {
  const [draftFilters, setDraftFilters] = useState<CommitHistoryFilters>({});
  const [filters, setFilters] = useState<CommitHistoryFilters>({});

  function setDraftFilter<K extends keyof CommitHistoryFilters>(key: K, value: string) {
    setDraftFilters((current) => ({ ...current, [key]: value || undefined }));
  }

  function applyFilters(overrides: CommitHistoryFilters = {}) {
    const next = Object.fromEntries(
      Object.entries({ ...draftFilters, ...overrides }).filter(([, value]) => typeof value === "string" && value.trim().length > 0).map(([key, value]) => [key, value?.trim()]),
    ) as CommitHistoryFilters;
    const query = next.message;
    if (query && /^[a-f\d]{7,64}$/i.test(query) && !next.sha) {
      next.sha = query;
      delete next.message;
    } else if (query && (/^author:\s*\S/i.test(query) || /^[^\s@]+@[^\s@]+$/.test(query)) && !next.author) {
      next.author = query.replace(/^author:\s*/i, "");
      delete next.message;
    }
    setFilters(next);
  }

  /** Replaces every filter with one path, as when a file's history is opened from elsewhere. */
  function showPath(path: string) {
    setDraftFilters({ path });
    setFilters({ path });
  }

  function resetFilters() {
    setDraftFilters({});
    setFilters({});
  }

  function removeFilter(key: keyof CommitHistoryFilters) {
    setDraftFilters((current) => ({ ...current, [key]: undefined, ...((key === "sha" || key === "author") && !current[key] ? { message: undefined } : {}) }));
    setFilters((current) => ({ ...current, [key]: undefined }));
  }

  const hasFilters = Object.values(filters).some((value) => typeof value === "string" && value.length > 0);

  return { draftFilters, filters, hasFilters, setDraftFilter, applyFilters, removeFilter, showPath, resetFilters };
}
