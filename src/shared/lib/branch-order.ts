interface BranchActivity {
  name: string;
  lastActivityAtMs?: number;
  isFavorite?: boolean;
  isCurrent?: boolean;
}

/** Activity always wins; flags and names keep branches with equal/unknown times stable. */
export function compareBranchActivity(left: BranchActivity, right: BranchActivity): number {
  return (right.lastActivityAtMs ?? 0) - (left.lastActivityAtMs ?? 0)
    || Number(Boolean(right.isFavorite)) - Number(Boolean(left.isFavorite))
    || Number(Boolean(right.isCurrent)) - Number(Boolean(left.isCurrent))
    || left.name.localeCompare(right.name);
}
