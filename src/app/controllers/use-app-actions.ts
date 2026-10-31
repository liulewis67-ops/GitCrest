import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";
import { useAppCommitActions } from "./use-app-commit-actions";
import { useAppEffects } from "./use-app-effects";
import { useAppFileActions } from "./use-app-file-actions";
import { useAppNavigation } from "./use-app-navigation";
import { useAppShortcuts } from "./use-app-shortcuts";

/** The app's handlers and effects, in the order they depend on each other. */
export function useAppActions(ctx: Shell & Connection & Repositories & DiffArea & Work) {
  const navigation = useAppNavigation(ctx);
  const commit = useAppCommitActions({ ...ctx, ...navigation });
  const files = useAppFileActions({ ...ctx, ...navigation });
  useAppEffects(ctx);
  useAppShortcuts({ ...ctx, ...navigation, ...commit });
  return { ...navigation, ...commit, ...files };
}

export type Actions = ReturnType<typeof useAppActions>;
