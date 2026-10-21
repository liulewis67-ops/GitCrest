export const loadSplitDiff = () => import("./ui/SplitDiff");
export const loadDiscardChangesDialog = () => import("./ui/DiscardChangesDialog");
export { DiffWindow } from "./ui/DiffWindow";
export { useRepositoryDiffQuery } from "./model/use-repository-diff-query";
export { splitInlineDiff } from "./model/inline-diff";
export const loadFileDiffViewer = () => import("./ui/FileDiffViewer");
export { useDiffViewPreferences, type DiffViewPreferences } from "./model/use-diff-view-preferences";
