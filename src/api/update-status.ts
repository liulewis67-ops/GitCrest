export type UpdateStatus =
  | { state: "notConfigured" }
  | { state: "idle" | "checking" | "notAvailable" }
  | { state: "available"; version: string }
  | { state: "downloading"; version?: string; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };
