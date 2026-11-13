import { useSyncExternalStore } from "react";

export const OPERATION_FLOW_KEY = "gitcrest-operation-flow-v1";
const changed = "gitcrest-operation-flow-changed";

/**
 * Opt-in (default off) to route preserved branch switches, commit checkouts and pulls through the durable
 * operations API. The server must also have GITCREST_OPERATION_CREATION enabled; otherwise the usual flow runs.
 */
export function isOperationFlowEnabled(): boolean {
  try {
    return window.localStorage.getItem(OPERATION_FLOW_KEY) === "on";
  } catch {
    return false;
  }
}

export function setOperationFlowEnabled(enabled: boolean) {
  if (enabled) window.localStorage.setItem(OPERATION_FLOW_KEY, "on");
  else window.localStorage.removeItem(OPERATION_FLOW_KEY);
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

export function useOperationFlowEnabled(): boolean {
  return useSyncExternalStore(subscribe, isOperationFlowEnabled, () => false);
}
