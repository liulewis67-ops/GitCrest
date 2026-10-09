export const loadCommitGraph = () => import("./CommitGraph").then(({ CommitGraph }) => ({ default: CommitGraph }));
export const loadCommitDetails = () => import("./CommitGraph").then(({ CommitDetails }) => ({ default: CommitDetails }));
export { useHistoryViewRequests, type CommitTagRequest, type HistorySearchFocusRequest } from "./model/use-history-view-requests";
