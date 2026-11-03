import { useSyncExternalStore } from "react";

export type BranchChangeMode = "keep" | "carry";
export type BranchChangePolicy = "ask" | BranchChangeMode;
export const BRANCH_CHANGE_POLICY_KEY = "gitcrest-branch-change-policy-v1";
const changed = "gitcrest-branch-change-policy-changed";

export function getBranchChangePolicy(): BranchChangePolicy {
  try {
    const value = window.localStorage.getItem(BRANCH_CHANGE_POLICY_KEY);
    return value === "keep" || value === "carry" ? value : "ask";
  } catch {
    return "ask";
  }
}

export function setBranchChangePolicy(policy: BranchChangePolicy) {
  window.localStorage.setItem(BRANCH_CHANGE_POLICY_KEY, policy);
  window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changed, listener);
  };
}

export function useBranchChangePolicy() {
  return useSyncExternalStore(subscribe, getBranchChangePolicy, () => "ask" as const);
}
