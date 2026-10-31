import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";
import type { Actions } from "./use-app-actions";
import type { ViewModel } from "./use-app-view-model";

/** Everything the app's areas share, built once per render in the order of the hooks above. */
export type AppContext = Shell & Connection & Repositories & DiffArea & Work & Actions & ViewModel;
