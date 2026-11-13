export const OPERATION_FLOW_KEY = "gitcrest-operation-flow-v1";

/**
 * Opt-in (default off) to route preserved branch switches through the durable operations API.
 * The server must also have GITCREST_OPERATION_CREATION enabled; otherwise the switch falls back.
 */
export function isOperationFlowEnabled(): boolean {
  try {
    return window.localStorage.getItem(OPERATION_FLOW_KEY) === "on";
  } catch {
    return false;
  }
}
