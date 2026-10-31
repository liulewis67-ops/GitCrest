import type { GitCrestApiClient, RepositoryResponse } from "../../api/client";
import type { useRepositoryStatus, useStagingOperations } from "../../features/changes";
import type { useRepositoryRefs } from "../../features/branches";
import type { useRepositoryListRefresh } from "../../features/repositories";

/**
 * What an earlier area needs from a later one, such as the core connection refreshing repositories
 * that the repository area owns. The app fills it in each render after every area has run, and the
 * earlier areas only read it from callbacks, so by then every member is there.
 */
export interface Forward {
  repositoryListRefresh: ReturnType<typeof useRepositoryListRefresh>;
  activateRepository: (repository: RepositoryResponse) => void;
  refreshRepositories: (api: GitCrestApiClient, restoreWorkspace?: boolean) => Promise<void>;
  refreshRepositoryStatusScope: ReturnType<typeof useRepositoryStatus>["refreshScope"];
  refreshRepositoryBranches: ReturnType<typeof useRepositoryRefs>["refreshBranches"];
  refreshRepositoryRemotes: ReturnType<typeof useRepositoryRefs>["refreshRemotes"];
  undoRecentOperation: ReturnType<typeof useStagingOperations>["undoRecentOperation"];
  requestShelfComposer: (repoId: string, preselect?: { paths: string[]; scope: "workingTree" | "index" }) => void;
}
