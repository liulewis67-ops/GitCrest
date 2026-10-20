import { app } from "./app";
import { branches } from "./branches";
import { branches2 } from "./branches2";
import { branches3 } from "./branches3";
import { history } from "./history";
import { commits } from "./commits";
import { diff } from "./diff";
import { workflows } from "./workflows";
import { conflicts } from "./conflicts";
import { tasks } from "./tasks";
import { privacy } from "./privacy";
import { errors } from "./errors";
import { misc } from "./misc";
import { remotes } from "./remotes";
import { remotes2 } from "./remotes2";
import { workspace } from "./workspace";
import { settings } from "./settings";

export const allMessages = { ...workspace, ...app, ...branches, ...branches2, ...branches3, ...remotes, ...remotes2, ...history, ...commits, ...diff, ...workflows, ...conflicts, ...tasks, ...privacy, ...errors, ...misc, ...settings } as const;
