/** The local Rust core as the Electron main process supervises it. */
export type CoreStatus =
  | { state: "ready"; generation: number }
  | { state: "unresponsive"; message: string }
  | { state: "restarting"; message: string }
  | { state: "failed"; message: string };
