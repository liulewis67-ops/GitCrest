import { useRef } from "react";
import { AppView } from "./controllers/AppView";
import { useAppActions } from "./controllers/use-app-actions";
import { useAppConnection } from "./controllers/use-app-connection";
import { useAppDiff } from "./controllers/use-app-diff";
import { useAppRepositories } from "./controllers/use-app-repositories";
import { useAppShell } from "./controllers/use-app-shell";
import { useAppViewModel } from "./controllers/use-app-view-model";
import { useAppWork } from "./controllers/use-app-work";
import type { Forward } from "./controllers/forward";

/**
 * Composes the app's areas. Each hook below owns one area and reads only what the hooks above it
 * return; the few things an earlier area needs from a later one go through `forward`.
 */
function App() {
  const forward = useRef({} as Forward).current;
  const shell = useAppShell();
  const connection = useAppConnection(shell, forward);
  const repositories = useAppRepositories({ ...shell, ...connection }, forward);
  const diff = useAppDiff({ ...shell, ...connection, ...repositories });
  const work = useAppWork({ ...shell, ...connection, ...repositories, ...diff });
  const actions = useAppActions({ ...shell, ...connection, ...repositories, ...diff, ...work });
  const viewModel = useAppViewModel({ ...shell, ...connection, ...repositories, ...diff, ...work, ...actions });
  const ctx = { ...shell, ...connection, ...repositories, ...diff, ...work, ...actions, ...viewModel };
  Object.assign(forward, {
    repositoryListRefresh: ctx.repositoryListRefresh,
    activateRepository: ctx.activateRepository,
    refreshRepositories: ctx.refreshRepositories,
    refreshRepositoryStatusScope: ctx.refreshRepositoryStatusScope,
    refreshRepositoryBranches: ctx.refreshRepositoryBranches,
    refreshRepositoryRemotes: ctx.refreshRepositoryRemotes,
    undoRecentOperation: ctx.undoRecentOperation,
    requestShelfComposer: ctx.requestShelfComposer,
  } satisfies Forward);
  return <AppView ctx={ctx} />;
}

export default App;
