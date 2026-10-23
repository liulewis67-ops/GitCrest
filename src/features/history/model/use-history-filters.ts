import { useState } from "react";
import type { CommitHistoryFilters } from "../../../api/client";

export function useHistoryFilters() {
  const [draftFilters, setDraftFilters] = useState<CommitHistoryFilters>({});
  const [filters, setFilters] = useState<CommitHistoryFilters>({});

  function setDraftFilter<K extends keyof CommitHistoryFilters>(key: K, value: string) {
    setDraftFilters((current) => ({ ...current, [key]: value || undefined }));
  }

  function applyFilters() {
    setFilters(Object.fromEntries(
      Object.entries(draftFilters).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
    ) as CommitHistoryFilters);
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

  const hasFilters = Object.values(filters).some((value) => typeof value === "string" && value.length > 0);

  return { draftFilters, filters, hasFilters, setDraftFilter, applyFilters, showPath, resetFilters };
}
